/**
 * In-memory token-bucket rate limiter. Adequate for a single self-hosted
 * instance (the deployment model here) — no Redis needed. Per-key buckets refill
 * continuously; `take` consumes one token and reports when the next is due.
 */
type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();

const DEFAULT_CAPACITY = 10; // burst size
const DEFAULT_REFILL_PER_SEC = 10 / 60; // ~10 per minute

export function take(
  key: string,
  capacity = DEFAULT_CAPACITY,
  refillPerSec = DEFAULT_REFILL_PER_SEC,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.updatedAt) / 1000) * refillPerSec);
  b.updatedAt = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return { ok: true, retryAfterSec: 0 };
  }
  buckets.set(key, b);
  return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / refillPerSec) };
}
