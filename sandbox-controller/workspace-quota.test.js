import { describe, it, expect } from "vitest";
import { createQuotaTracker } from "./workspace-quota.js";

// A controllable clock so TTL behaviour is deterministic (no real sleeps).
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const MB = 1024 * 1024;

describe("createQuotaTracker — workspace disk-quota gate", () => {
  it("is under quota below the limit, over at or above it", async () => {
    let bytes = 0;
    const q = createQuotaTracker({ size: async () => bytes, limitBytes: 100 * MB, ttlMs: 0 });
    bytes = 99 * MB;
    expect(await q.isOverQuota("u", "s")).toBe(false);
    bytes = 100 * MB; // exactly at the cap counts as full
    expect(await q.isOverQuota("u", "s")).toBe(true);
    bytes = 200 * MB;
    expect(await q.isOverQuota("u", "s")).toBe(true);
  });

  it("caches the size for ttlMs so a burst of execs triggers only one du", async () => {
    let calls = 0;
    const clock = fakeClock();
    const q = createQuotaTracker({
      size: async () => { calls++; return 10 * MB; },
      limitBytes: 100 * MB, ttlMs: 5000, now: clock.now,
    });
    await q.isOverQuota("u", "s");
    await q.isOverQuota("u", "s");
    await q.isOverQuota("u", "s");
    expect(calls).toBe(1); // coalesced within the TTL window
  });

  it("recomputes once the cache entry is older than ttlMs", async () => {
    let calls = 0;
    const clock = fakeClock();
    const q = createQuotaTracker({
      size: async () => { calls++; return 10 * MB; },
      limitBytes: 100 * MB, ttlMs: 5000, now: clock.now,
    });
    await q.isOverQuota("u", "s");
    clock.advance(5001);
    await q.isOverQuota("u", "s");
    expect(calls).toBe(2);
  });

  it("uses a size fed via note() instead of recomputing (GC feeds the cache for free)", async () => {
    let calls = 0;
    const clock = fakeClock();
    const q = createQuotaTracker({
      size: async () => { calls++; return 0; },
      limitBytes: 100 * MB, ttlMs: 5000, now: clock.now,
    });
    q.note("s", 150 * MB);
    expect(await q.isOverQuota("u", "s")).toBe(true);
    expect(calls).toBe(0); // never walked the tree — used the noted size
  });

  it("treats a non-positive limit as disabled and never walks the tree", async () => {
    let calls = 0;
    const q = createQuotaTracker({ size: async () => { calls++; return 1e12; }, limitBytes: 0 });
    expect(await q.isOverQuota("u", "s")).toBe(false);
    expect(calls).toBe(0);
  });

  it("forget() drops the cached entry so the next check recomputes", async () => {
    let calls = 0;
    const clock = fakeClock();
    const q = createQuotaTracker({
      size: async () => { calls++; return 10 * MB; },
      limitBytes: 100 * MB, ttlMs: 5000, now: clock.now,
    });
    await q.isOverQuota("u", "s");
    q.forget("s");
    await q.isOverQuota("u", "s");
    expect(calls).toBe(2);
  });
});
