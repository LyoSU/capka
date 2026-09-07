import { describe, it, expect, vi } from "vitest";
import { awaitWithin } from "../worker";

// Shutdown order is: stop the Telegram bot (which flushes message bursts, so it
// can do file downloads and DB writes) → drain in-flight tasks for 25s → flush
// telemetry. Docker's stop_grace_period is 35s, so the first step cannot be
// allowed to wait forever: an unbounded flush eats the drain's budget and the
// running tasks are SIGKILLed instead of finishing.
describe("awaitWithin", () => {
  it("reports finished when the work settles inside the budget", async () => {
    const sleep = vi.fn(() => new Promise<void>(() => {})); // budget never elapses
    await expect(awaitWithin(Promise.resolve("done"), 3_000, sleep)).resolves.toBe(true);
  });

  it("reports NOT finished when the budget elapses first, without throwing", async () => {
    const never = new Promise(() => {});
    await expect(awaitWithin(never, 3_000, async () => {})).resolves.toBe(false);
  });

  it("stops blocking on the budget and lets the work keep running afterwards", async () => {
    let settle!: () => void;
    const work = new Promise<void>((r) => { settle = r; });
    const finished: string[] = [];
    void work.then(() => finished.push("flush finished"));

    expect(await awaitWithin(work, 3_000, async () => {})).toBe(false);
    finished.push("drain started");
    // The work was never cancelled — it completes on its own, after shutdown
    // moved on. (Its enqueues are durable, which is why this is safe.)
    settle();
    await work;
    expect(finished).toEqual(["drain started", "flush finished"]);
  });

  it("counts a rejection as finished, so a failing stop does not burn the budget", async () => {
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    await expect(awaitWithin(Promise.reject(new Error("stop failed")), 3_000, sleep)).resolves.toBe(true);
  });
});
