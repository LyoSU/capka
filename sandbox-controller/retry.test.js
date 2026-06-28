import { describe, it, expect, vi } from "vitest";
import { withRetry } from "./retry.js";

const noSleep = vi.fn().mockResolvedValue();

describe("withRetry", () => {
  it("returns the result without retrying on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure then succeeds, sleeping between attempts", async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue("recovered");
    expect(await withRetry(fn, { attempts: 5, baseMs: 10, sleep })).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // Linear backoff (baseMs * attempt) with full jitter: each delay lands in
    // [50% .. 100%] of its nominal window.
    const [d1] = sleep.mock.calls[0];
    const [d2] = sleep.mock.calls[1];
    expect(d1).toBeGreaterThanOrEqual(5);
    expect(d1).toBeLessThanOrEqual(10);
    expect(d2).toBeGreaterThanOrEqual(10);
    expect(d2).toBeLessThanOrEqual(20);
  });

  it("re-throws the last error after exhausting the budget (no sleep after final try)", async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fn = vi.fn().mockRejectedValue(new Error("daemon down"));
    await expect(withRetry(fn, { attempts: 3, baseMs: 5, sleep })).rejects.toThrow("daemon down");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
