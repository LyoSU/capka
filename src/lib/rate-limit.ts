/**
 * In-memory token-bucket rate limiter. Adequate for a single self-hosted
 * instance (the deployment model here) — no Redis needed. Per-key buckets refill
 * continuously; `take` consumes one token and reports when the next is due.
 */
type Bucket = { tokens: number; updatedAt: number };

export type RateLimitPolicy = Readonly<{
  capacity: number;
  refillPerSec: number;
}>;

/** Named policies keep related endpoints on the same budget and prevent route
 *  authors from scattering unexplained token-bucket constants through handlers. */
export const RATE_LIMITS = {
  // Archive generation/streaming is CPU + disk + bandwidth heavy. Permit one
  // retry burst, then replenish one slot every 30 seconds.
  workspaceArchive: { capacity: 2, refillPerSec: 1 / 30 },
  // An accepted answer resumes a suspended (potentially paid) model turn.
  askAnswer: { capacity: 10, refillPerSec: 1 / 6 },
  // Installs/upgrades fetch and parse third-party repositories.
  extensionMutation: { capacity: 3, refillPerSec: 1 / 20 },
  // Fork/clone copy a conversation branch and can amplify large histories.
  chatCopy: { capacity: 5, refillPerSec: 1 / 12 },
} satisfies Record<string, RateLimitPolicy>;

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

/** HTTP adapter for route handlers. Returns null when the request may proceed. */
export function guardRateLimit(
  key: string,
  policy: RateLimitPolicy,
  message = "Too many requests — please slow down.",
): Response | null {
  const result = take(key, policy.capacity, policy.refillPerSec);
  if (result.ok) return null;
  return Response.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSec) } },
  );
}
