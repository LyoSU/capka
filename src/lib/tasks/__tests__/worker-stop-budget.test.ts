import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { awaitWithin, stopThenDrain } from "../worker";

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

// Fixed slots threw away the rest of the grace period: on an idle worker the
// drain returns at once, so a burst flush still downloading a Telegram album was
// killed ~3s into a 35s window. The two halves share ONE budget instead.
describe("stopThenDrain", () => {
  const FIRST_WAIT = 3_000;
  const BUDGET = 30_000;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Records the outcome plus the virtual elapsed ms at which the shutdown
  // stopped waiting — the deadline claim is about WHEN it returns, so the moment
  // is the assertion, not just the verdict.
  function run(stopping: Promise<unknown>, drainTasks: () => Promise<unknown>) {
    const t0 = Date.now();
    let out: { stopped: boolean; drainFinished: boolean; elapsed: number } | undefined;
    const done = stopThenDrain(stopping, drainTasks, FIRST_WAIT, t0 + BUDGET).then((r) => {
      out = { ...r, elapsed: Date.now() - t0 };
    });
    return { done, at: () => out };
  }

  it("keeps waiting for a slow stop once an idle drain has returned", async () => {
    const stopping = new Promise((r) => setTimeout(r, 10_000)); // a big album download
    const r = run(stopping, async () => {}); // nothing in flight: drain is instant

    await vi.advanceTimersByTimeAsync(BUDGET);
    await r.done;
    // Waited the full 10s the flush needed — not cut off at the 3s handover.
    expect(r.at()).toEqual({ stopped: true, drainFinished: true, elapsed: 10_000 });
  });

  it("gives up at the hard deadline when the stop never finishes", async () => {
    const r = run(new Promise(() => {}), async () => {});

    await vi.advanceTimersByTimeAsync(BUDGET + 10_000);
    await r.done;
    // Exits with the telemetry reserve intact, rather than hanging into SIGKILL.
    expect(r.at()).toEqual({ stopped: false, drainFinished: true, elapsed: BUDGET });
  });

  it("starts the task drain at the handover instead of queueing it behind the stop", async () => {
    const order: string[] = [];
    const stopping = new Promise<void>((r) => setTimeout(() => { order.push("stop finished"); r(); }, 10_000));
    const r = run(stopping, async () => { order.push(`drain started at ${Date.now() % 100_000}`); });

    await vi.advanceTimersByTimeAsync(BUDGET);
    await r.done;
    expect(order[0]).toMatch(/^drain started/); // ran while the stop was still going
    expect(order[1]).toBe("stop finished");
  });

  it("does not wait a second time when the stop finished inside the first wait", async () => {
    const r = run(Promise.resolve(), async () => { await new Promise((res) => setTimeout(res, 25_000)); });

    await vi.advanceTimersByTimeAsync(BUDGET);
    await r.done;
    // The drain still owns its own time; the stop adds nothing after it.
    expect(r.at()).toEqual({ stopped: true, drainFinished: true, elapsed: 25_000 });
  });

  it("stops waiting on the drain AT the deadline, not after it", async () => {
    // 3s handover + a 28s drain would run to 31s; the deadline is 30s, and the
    // drain is bounded by it too — otherwise the deadline binds only the stop.
    const r = run(new Promise(() => {}), async () => { await new Promise((res) => setTimeout(res, 28_000)); });

    await vi.advanceTimersByTimeAsync(BUDGET + 10_000);
    await r.done;
    // Returns exactly at the deadline, with nothing left to give the stop and no
    // negative wait.
    expect(r.at()).toEqual({ stopped: false, drainFinished: false, elapsed: BUDGET });
  });
});
