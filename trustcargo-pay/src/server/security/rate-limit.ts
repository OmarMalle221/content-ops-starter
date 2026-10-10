/**
 * Fixed-window rate limiter. In-process implementation for single-instance deployments and tests;
 * multi-instance production must swap this for a shared store (e.g. Redis) behind the same interface.
 */
export interface RateLimiter {
    consume(key: string, limit: number, windowMs: number, now?: number): { allowed: boolean; remaining: number; resetAt: number };
}

export class InMemoryRateLimiter implements RateLimiter {
    private readonly buckets = new Map<string, { count: number; resetAt: number }>();

    consume(key: string, limit: number, windowMs: number, now = Date.now()) {
        let bucket = this.buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            this.buckets.set(key, bucket);
        }
        bucket.count += 1;
        if (this.buckets.size > 10_000) this.prune(now);
        return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
    }

    private prune(now: number) {
        for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    }
}
