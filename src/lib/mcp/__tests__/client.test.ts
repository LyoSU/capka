import { describe, it, expect } from "vitest";
import { withTimeout } from "../client";

describe("withTimeout", () => {
  it("resolves when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "x")).resolves.toBe("ok");
  });
  it("rejects with a labelled error when the promise hangs", async () => {
    const hang = new Promise<never>(() => {}); // never settles
    await expect(withTimeout(hang, 20, "connect to notion")).rejects.toThrow(/connect to notion.*timed out/i);
  });
});
