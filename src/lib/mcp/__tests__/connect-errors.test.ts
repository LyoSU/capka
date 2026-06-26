import { describe, it, expect } from "vitest";
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
