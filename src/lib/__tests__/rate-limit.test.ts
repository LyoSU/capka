import { describe, expect, it, vi } from "vitest";
import { guardRateLimit, take, type RateLimitPolicy } from "../rate-limit";

describe("rate limiter", () => {
  it("enforces capacity and continuously refills the bucket", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const key = `test-refill-${Math.random()}`;
      expect(take(key, 2, 1).ok).toBe(true);
      expect(take(key, 2, 1).ok).toBe(true);
      expect(take(key, 2, 1)).toEqual({ ok: false, retryAfterSec: 1 });

      vi.advanceTimersByTime(1_000);
      expect(take(key, 2, 1).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a standard 429 response with Retry-After", async () => {
    const key = `test-http-${Math.random()}`;
    const policy: RateLimitPolicy = { capacity: 1, refillPerSec: 1 / 30 };
    expect(guardRateLimit(key, policy)).toBeNull();

    const response = guardRateLimit(key, policy, "Slow down.");
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("30");
    expect(await response?.json()).toEqual({ error: "Slow down." });
  });
});
