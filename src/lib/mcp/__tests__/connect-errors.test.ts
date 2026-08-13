import { describe, it, expect, vi, afterEach } from "vitest";
import { recordConnectError, clearConnectError, getConnectError, recentlyFailed } from "../connect-errors";

const U = "user-1";

describe("recentlyFailed (connect backoff)", () => {
  it("is false for a server that never failed", () => {
    expect(recentlyFailed(U, "never", 30_000)).toBe(false);
  });

  it("is true right after a failure, within the backoff window", () => {
    recordConnectError(U, "s1", "boom");
    expect(recentlyFailed(U, "s1", 30_000)).toBe(true);
  });

  it("is false once the backoff window has elapsed (so a recovered server is retried)", async () => {
    recordConnectError(U, "s2", "boom");
    await new Promise((r) => setTimeout(r, 20));
    expect(recentlyFailed(U, "s2", 5)).toBe(false);
  });

  it("clears on success so the next run reconnects immediately", () => {
    recordConnectError(U, "s3", "boom");
    clearConnectError(U, "s3");
    expect(recentlyFailed(U, "s3", 30_000)).toBe(false);
  });

  it("is isolated per user — one user's failure on a shared server never affects another", () => {
    recordConnectError("userA", "shared", "userA token revoked");
    expect(recentlyFailed("userB", "shared", 30_000)).toBe(false);
    expect(getConnectError("userB", "shared")).toBeNull();
    // userA still sees their own failure.
    expect(getConnectError("userA", "shared")).toBe("userA token revoked");
  });
});

/**
 * The map is keyed per (user, server) and nothing sweeps it on the read side for a
 * connector that no longer exists — the health endpoint only asks about live rows.
 * So a record bounds it: entries past the TTL, which are already dead to every
 * reader, go on the way in. Asserted through a backoff window WIDER than the TTL,
 * since that is the only way the difference is observable from outside.
 */
describe("retention", () => {
  const TTL_MS = 10 * 60_000;
  const T0 = new Date("2026-01-01T00:00:00Z").getTime();
  afterEach(() => vi.useRealTimers());

  it("drops an entry past the TTL when a later failure is recorded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    recordConnectError(U, "retention-stale", "boom");
    vi.setSystemTime(T0 + TTL_MS + 60_000);
    recordConnectError(U, "retention-fresh", "boom");

    expect(recentlyFailed(U, "retention-stale", 60 * 60_000)).toBe(false);
    expect(recentlyFailed(U, "retention-fresh", 60 * 60_000)).toBe(true);
  });

  it("keeps an entry still inside the TTL, so the backoff it drives survives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    recordConnectError(U, "retention-recent", "boom");
    vi.setSystemTime(T0 + TTL_MS - 60_000);
    recordConnectError(U, "retention-other", "boom");

    expect(recentlyFailed(U, "retention-recent", TTL_MS)).toBe(true);
  });
});
