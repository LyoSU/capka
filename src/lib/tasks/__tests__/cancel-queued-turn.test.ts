import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `cancelQueuedTurn` has two arms and they must not be confused, because they own
 * different amounts of cleanup: the DELETE arm is the ONLY thing that can ever
 * release the row's budget hold (nothing can attribute a hold whose task row is
 * gone), while the flag arm hands both the cancellation and the hold to the worker
 * that just claimed it. Doing the delete arm's cleanup on the flag path would
 * release a hold the running turn is still spending against.
 *
 * The real DELETE-vs-claim race needs Postgres — see
 * src/app/api/tasks/__tests__/queue-visibility.integration.test.ts.
 */
const { query, execute } = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
// What ran inside the transaction, so a test can tell it from what ran outside it.
const { inTx } = vi.hoisted(() => ({ inTx: { depth: 0, calls: [] as boolean[] } }));
const { releaseHold } = vi.hoisted(() => ({ releaseHold: vi.fn() }));
const { publishTaskEvent } = vi.hoisted(() => ({ publishTaskEvent: vi.fn() }));

vi.mock("@/lib/db", () => {
  const tx = { execute: (...a: unknown[]) => { inTx.calls.push(inTx.depth > 0); return execute(...a); } };
  return {
    pool: { query },
    db: {
      ...tx,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        inTx.depth++;
        try { return await fn(tx); } finally { inTx.depth--; }
      },
    },
  };
});
vi.mock("@/lib/realtime", () => ({ realtime: { publish: vi.fn(), subscribe: vi.fn() } }));
vi.mock("@/lib/billing/limits", () => ({ releaseHold }));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent }));

import { cancelQueuedTurn } from "../queue";

const input = { id: "task-q", userId: "u1", chatId: "c1" };
/** The statements issued, first line only, for readable assertions. */
const statements = () => query.mock.calls.map((c) => String(c[0]).trim().split("\n")[0].trim());

beforeEach(() => {
  vi.clearAllMocks();
  inTx.calls.length = 0;
  execute.mockResolvedValue({ rows: [] });
  publishTaskEvent.mockResolvedValue(undefined);
  releaseHold.mockResolvedValue(undefined);
});

describe("cancelQueuedTurn", () => {
  it("removes the row, releases its hold and announces the outcome", async () => {
    query.mockResolvedValue({ rows: [{ id: "task-q" }] });

    await expect(cancelQueuedTurn(input)).resolves.toBe("removed");

    expect(statements()[0]).toMatch(/^DELETE FROM tasks/);
    // The flag is pointless once the row is gone — and issuing it would mean the
    // delete didn't take.
    expect(statements().some((s) => s.startsWith("UPDATE tasks"))).toBe(false);
    expect(releaseHold).toHaveBeenCalledWith("task-q");
    expect(publishTaskEvent).toHaveBeenCalledWith("u1", {
      type: "task:finish",
      taskId: "task-q",
      chatId: "c1",
      status: "cancelled",
    });
  });

  it("falls back to the cooperative flag when a worker claimed the row first", async () => {
    // DELETE ... WHERE status = 'queued' matched nothing: the row is running now.
    query.mockResolvedValue({ rows: [] });

    await expect(cancelQueuedTurn(input)).resolves.toBe("flagged");

    expect(statements().some((s) => s.startsWith("UPDATE tasks"))).toBe(true);
    // The turn is live and spending — its own finalize owns the hold and the event.
    expect(releaseHold).not.toHaveBeenCalled();
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });

  // A continuation's row waits on this task. Settling it after the delete committed
  // could throw and leave the row waiting with nothing left to settle it, while the
  // caller reported a failure for a delete that had happened.
  it("deletes a continuation and settles its row in one transaction", async () => {
    // The plain-turn DELETE skips a continuation; the transaction's removes it.
    query.mockResolvedValue({ rows: [] });
    execute
      .mockResolvedValueOnce({ rows: [{ id: "task-q", resume: "m1" }] })
      .mockResolvedValueOnce({ rows: [{ metadata: { status: "awaiting_answer", parts: [] } }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(cancelQueuedTurn(input)).resolves.toBe("removed");

    expect(statements()).toHaveLength(1);
    expect(statements()[0]).toMatch(/^DELETE FROM tasks/);
    // The delete, the read and the settle, all inside it.
    expect(inTx.calls).toEqual([true, true, true]);
    expect(releaseHold).toHaveBeenCalledWith("task-q");
    expect(publishTaskEvent).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "task:finish", status: "cancelled" }));
  });

  it("reports nothing removed when that settle throws", async () => {
    query.mockResolvedValue({ rows: [] });
    execute
      .mockResolvedValueOnce({ rows: [{ id: "task-q", resume: "m1" }] })
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    await expect(cancelQueuedTurn(input)).rejects.toThrow(/Connection terminated/);

    // The delete rolled back with it: the turn is still queued, so its hold stays and
    // no outcome is announced.
    expect(inTx.calls).toEqual([true, true]);
    expect(releaseHold).not.toHaveBeenCalled();
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });
});
