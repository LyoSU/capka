/**
 * In-memory token-bucket rate limiter. Adequate for a single self-hosted
 * instance (the deployment model here) — no Redis needed. Per-key buckets refill
 * continuously; `take` consumes one token and reports when the next is due.
 */
type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();

const DEFAULT_CAPACITY = 10; // burst size
const DEFAULT_REFILL_PER_SEC = 10 / 60; // ~10 per minute

// The map otherwise grows one bucket per distinct key forever (a slow leak that
// matters on a long-lived instance). Sweep idle buckets periodically; a bucket
// untouched this long has fully refilled and is indistinguishable from absent.
const IDLE_EVICT_MS = 10 * 60 * 1000;
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < IDLE_EVICT_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (now - b.updatedAt > IDLE_EVICT_MS) buckets.delete(k);
}

export function take(
  key: string,
  capacity = DEFAULT_CAPACITY,
  refillPerSec = DEFAULT_REFILL_PER_SEC,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  sweep(now);
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
