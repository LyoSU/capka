import { describe, it, expect } from "vitest";
import { recordConnectError, clearConnectError, recentlyFailed } from "../connect-errors";

describe("recentlyFailed (connect backoff)", () => {
  it("is false for a server that never failed", () => {
    expect(recentlyFailed("never", 30_000)).toBe(false);
  });

  it("is true right after a failure, within the backoff window", () => {
    recordConnectError("s1", "boom");
    expect(recentlyFailed("s1", 30_000)).toBe(true);
  });

  it("is false once the backoff window has elapsed (so a recovered server is retried)", async () => {
    recordConnectError("s2", "boom");
    await new Promise((r) => setTimeout(r, 20));
    // 20ms elapsed against a 5ms window → eligible to retry again.
    expect(recentlyFailed("s2", 5)).toBe(false);
  });

  it("clears on success so the next run reconnects immediately", () => {
    recordConnectError("s3", "boom");
    clearConnectError("s3");
    expect(recentlyFailed("s3", 30_000)).toBe(false);
  });
});
