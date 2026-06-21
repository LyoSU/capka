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
    expect(sleep).toHaveBeenNthCalledWith(1, 10); // linear backoff: baseMs * attempt
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("re-throws the last error after exhausting the budget (no sleep after final try)", async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fn = vi.fn().mockRejectedValue(new Error("daemon down"));
    await expect(withRetry(fn, { attempts: 3, baseMs: 5, sleep })).rejects.toThrow("daemon down");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
