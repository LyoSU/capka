import { describe, it, expect } from "vitest";
import { drainInFlight } from "../drain";

describe("drainInFlight", () => {
  it("resolves immediately when nothing is in flight", async () => {
    const res = await drainInFlight(() => 0, 1000);
    expect(res).toEqual({ drained: true, remaining: 0 });
  });

  it("waits until in-flight work finishes, then reports drained", async () => {
    let inFlight = 2;
    // Two tasks finish shortly after drain begins.
    setTimeout(() => { inFlight = 1; }, 20);
    setTimeout(() => { inFlight = 0; }, 40);
    const res = await drainInFlight(() => inFlight, 1000);
    expect(res).toEqual({ drained: true, remaining: 0 });
  });

  it("gives up at the grace deadline and reports what's still running", async () => {
    const res = await drainInFlight(() => 1, 60); // never reaches 0
    expect(res.drained).toBe(false);
    expect(res.remaining).toBe(1);
  });
});
