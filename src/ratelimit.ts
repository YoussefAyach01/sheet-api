/** Fixed-window in-memory limiter. Good for a single instance; use Redis if you scale out. */
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private windowMs = 60_000) {}

  check(id: string, limit: number, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    const cur = this.hits.get(id);
    if (!cur || now - cur.windowStart >= this.windowMs) {
      this.hits.set(id, { windowStart: now, count: 1 });
      if (this.hits.size > 10_000) this.prune(now);
      return { ok: true, retryAfterSec: 0 };
    }
    cur.count += 1;
    if (cur.count > limit) {
      return {
        ok: false,
        retryAfterSec: Math.ceil((cur.windowStart + this.windowMs - now) / 1000),
      };
    }
    return { ok: true, retryAfterSec: 0 };
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (now - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}
