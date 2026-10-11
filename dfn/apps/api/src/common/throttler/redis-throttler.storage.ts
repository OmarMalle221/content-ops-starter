import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import { LuaScript, REDIS_KEY_PREFIX, type RedisClientSource } from '../redis';

/** The record @nestjs/throttler expects (not re-exported by the package index). */
export type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Fixed window per (throttler, tracker key) with an optional block period, atomically:
 *  - while the block key lives, the request is refused without being counted;
 *  - otherwise the hit is counted (INCR, TTL set on the first hit of the window);
 *  - above the limit, the block key is set for `blockDuration` and the window restarts after it
 *    (same semantics as the in-memory ThrottlerStorageService).
 * Returns { totalHits, timeToExpireMs, isBlocked (1|0), timeToBlockExpireMs }.
 */
const INCREMENT = new LuaScript(`
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  return {limit + 1, blockTtl, 1, blockTtl}
end
local hits = redis.call('INCR', hitsKey)
local hitsTtl = redis.call('PTTL', hitsKey)
if hitsTtl < 0 then
  redis.call('PEXPIRE', hitsKey, ttl)
  hitsTtl = ttl
end
if hits > limit then
  if block > 0 then
    redis.call('SET', blockKey, '1', 'PX', block)
    redis.call('DEL', hitsKey)
    return {hits, block, 1, block}
  end
  return {hits, hitsTtl, 1, hitsTtl}
end
return {hits, hitsTtl, 0, 0}
`);

const DEGRADED_LOG_INTERVAL_MS = 30_000;

/**
 * ThrottlerStorage backed by Redis (RATE_LIMIT_STORE=redis): the global per-IP throttle is shared
 * by every API replica. Keys: `dfn:rl:throttler:<name>:<key>` (+ `:block`), all with a TTL.
 * When Redis is unreachable the storage degrades to the in-memory implementation of
 * @nestjs/throttler (per-replica limits) rather than failing every request.
 */
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly logger = new Logger('Throttler');
  private fallback?: ThrottlerStorageService;
  private lastDegradedLog = 0;

  constructor(
    private readonly redis: RedisClientSource,
    private readonly prefix = `${REDIS_KEY_PREFIX}rl:throttler:`,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `${this.prefix}${throttlerName}:${key}`;
    try {
      const [totalHits, ttlMs, blocked, blockMs] = await INCREMENT.run<[number, number, number, number]>(
        this.redis.client(),
        [hitsKey, `${hitsKey}:block`],
        [Math.max(Math.ceil(ttl), 1), limit, Math.max(Math.ceil(blockDuration), 0)],
      );
      return {
        totalHits: Number(totalHits),
        timeToExpire: Math.ceil(Number(ttlMs) / 1000),
        isBlocked: Number(blocked) === 1,
        timeToBlockExpire: Number(blocked) === 1 ? Math.ceil(Number(blockMs) / 1000) : 0,
      };
    } catch (err) {
      this.degraded(err);
      this.fallback ??= new ThrottlerStorageService();
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  onApplicationShutdown() {
    this.fallback?.onApplicationShutdown();
  }

  private degraded(err: unknown) {
    const now = Date.now();
    if (now - this.lastDegradedLog < DEGRADED_LOG_INTERVAL_MS) return;
    this.lastDegradedLog = now;
    this.logger.warn(
      `redis throttler storage unavailable — falling back to per-replica memory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
