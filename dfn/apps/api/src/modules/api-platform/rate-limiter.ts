import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { LuaScript, REDIS_KEY_PREFIX, type RedisClientSource } from '../../common/redis';

/**
 * Per-API-key rate limiting (sliding window) and one-shot claims ("do X at most once per
 * interval"), behind a store interface selected by RATE_LIMIT_STORE:
 *
 *  - `memory` — counters live in this replica (one replica = exact limits; N replicas = up to
 *    N × the limit). Memory is bounded: at most `limit` timestamps per active key, idle keys are
 *    evicted on the next sweep.
 *  - `redis`  — counters are shared by every replica: an atomic Lua script maintains one sorted
 *    set per key (`dfn:rl:sw:<key>`, timestamps from the Redis clock, TTL = window), and claims
 *    are `SET dfn:rl:once:<key> NX PX ttl`. When Redis is unreachable the store degrades to the
 *    in-memory implementation (per-replica limits) instead of failing the request.
 */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a slot frees up (only meaningful when `allowed` is false). */
  retryAfterSeconds: number;
}

export type RateLimitStoreKind = 'memory' | 'redis';

export interface RateLimitStore {
  readonly kind: RateLimitStoreKind;
  /** Counts one request of `key` in a sliding window of `windowMs`; refuses beyond `limit`. */
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  /**
   * True when the caller obtained the claim on `key` for `ttlMs` — i.e. nobody (on any replica,
   * for the Redis store) claimed it during the last `ttlMs`.
   */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Forgets the window and the claim of `key`. */
  reset(key: string): Promise<void>;
}

/** In-memory sliding-window engine (kept public: pure, synchronous, unit-tested). */
export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly windowMs = 60_000) {}

  hit(key: string, limit: number, now = Date.now()): RateLimitDecision {
    this.sweep(now);
    const cutoff = now - this.windowMs;
    let stamps = this.windows.get(key);
    if (!stamps) {
      stamps = [];
      this.windows.set(key, stamps);
    }
    // Drop timestamps outside the window (array is kept in insertion order).
    let drop = 0;
    while (drop < stamps.length && stamps[drop]! <= cutoff) drop++;
    if (drop > 0) stamps.splice(0, drop);

    if (stamps.length >= limit) {
      const oldest = stamps[0]!;
      const retryAfterMs = Math.max(oldest + this.windowMs - now, 1);
      return { allowed: false, limit, remaining: 0, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }
    stamps.push(now);
    return { allowed: true, limit, remaining: Math.max(limit - stamps.length, 0), retryAfterSeconds: 0 };
  }

  /** Forgets a key (used when a credential is revoked). */
  reset(key: string) {
    this.windows.delete(key);
  }

  /** Evicts keys that have been idle for a full window, at most once per window. */
  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, stamps] of this.windows) {
      const last = stamps[stamps.length - 1];
      if (last === undefined || last <= cutoff) this.windows.delete(key);
    }
  }
}

/** RATE_LIMIT_STORE=memory — the historical per-replica behaviour. */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly kind = 'memory' as const;
  private readonly limiters = new Map<number, SlidingWindowRateLimiter>();
  private readonly claims = new Map<string, number>();
  private lastClaimSweep = 0;

  async hit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitDecision> {
    let limiter = this.limiters.get(windowMs);
    if (!limiter) {
      limiter = new SlidingWindowRateLimiter(windowMs);
      this.limiters.set(windowMs, limiter);
    }
    return limiter.hit(key, limit, now);
  }

  async claim(key: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    this.sweepClaims(now, ttlMs);
    const expiresAt = this.claims.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.claims.set(key, now + ttlMs);
    return true;
  }

  async reset(key: string): Promise<void> {
    for (const limiter of this.limiters.values()) limiter.reset(key);
    this.claims.delete(key);
  }

  /** Drops expired claims, at most once per claim interval (bounded memory). */
  private sweepClaims(now: number, intervalMs: number) {
    if (now - this.lastClaimSweep < intervalMs) return;
    this.lastClaimSweep = now;
    for (const [key, expiresAt] of this.claims) if (expiresAt <= now) this.claims.delete(key);
  }
}

/**
 * Sliding-window log on a sorted set, atomically: purge entries older than the window, count,
 * then either refuse (with the delay until the oldest entry leaves the window) or record the hit.
 * Time comes from the Redis server so that replicas with skewed clocks share one timeline.
 * Returns { allowed (1|0), remaining, retryAfterMs }.
 */
const SLIDING_WINDOW = new LuaScript(`
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  if retry < 1 then retry = 1 end
  return {0, 0, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, limit - count - 1, 0}
`);

/** Logs Redis degradations at most once per interval. */
const DEGRADED_LOG_INTERVAL_MS = 30_000;

/** RATE_LIMIT_STORE=redis — limits shared by every replica (keys `dfn:rl:*`, all with a TTL). */
export class RedisRateLimitStore implements RateLimitStore {
  readonly kind = 'redis' as const;
  private readonly logger = new Logger('RateLimit');
  private readonly fallback: RateLimitStore;
  private lastDegradedLog = 0;

  constructor(
    private readonly redis: RedisClientSource,
    private readonly prefix = `${REDIS_KEY_PREFIX}rl:`,
    fallback?: RateLimitStore,
  ) {
    this.fallback = fallback ?? new MemoryRateLimitStore();
  }

  windowKey(key: string) {
    return `${this.prefix}sw:${key}`;
  }

  claimKey(key: string) {
    return `${this.prefix}once:${key}`;
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    try {
      const member = `${Date.now()}-${randomBytes(6).toString('hex')}`;
      const [allowed, remaining, retryMs] = await SLIDING_WINDOW.run<[number, number, number]>(
        this.redis.client(),
        [this.windowKey(key)],
        [limit, windowMs, member],
      );
      return allowed === 1
        ? { allowed: true, limit, remaining: Math.max(Number(remaining), 0), retryAfterSeconds: 0 }
        : { allowed: false, limit, remaining: 0, retryAfterSeconds: Math.ceil(Number(retryMs) / 1000) };
    } catch (err) {
      this.degraded('hit', err);
      return this.fallback.hit(key, limit, windowMs);
    }
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    try {
      const reply = await this.redis.client().set(this.claimKey(key), '1', 'PX', ttlMs, 'NX');
      return reply === 'OK';
    } catch (err) {
      this.degraded('claim', err);
      return this.fallback.claim(key, ttlMs);
    }
  }

  async reset(key: string): Promise<void> {
    await this.fallback.reset(key);
    try {
      await this.redis.client().del(this.windowKey(key), this.claimKey(key));
    } catch (err) {
      this.degraded('reset', err);
    }
  }

  private degraded(operation: string, err: unknown) {
    const now = Date.now();
    if (now - this.lastDegradedLog < DEGRADED_LOG_INTERVAL_MS) return;
    this.lastDegradedLog = now;
    this.logger.warn(
      `redis rate-limit ${operation} failed — falling back to per-replica memory limits: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Store selected by RATE_LIMIT_STORE (`redis` requires a Redis client source). */
export function createRateLimitStore(kind: RateLimitStoreKind, redis?: RedisClientSource): RateLimitStore {
  if (kind === 'redis') {
    if (!redis) throw new Error('RATE_LIMIT_STORE=redis requires a Redis connection (REDIS_URL)');
    return new RedisRateLimitStore(redis);
  }
  return new MemoryRateLimitStore();
}
