/**
 * In-memory sliding-window rate limiter keyed by credential id.
 *
 * One API replica keeps its own counters, which is acceptable for the sandbox (a single replica)
 * and documented as such; a Redis-backed window is the production evolution. Memory is bounded:
 * at most `limit` timestamps per active key, idle keys are evicted on the next sweep.
 */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a slot frees up (only meaningful when `allowed` is false). */
  retryAfterSeconds: number;
}

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
