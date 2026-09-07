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
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
const { releaseHold } = vi.hoisted(() => ({ releaseHold: vi.fn() }));
const { publishTaskEvent } = vi.hoisted(() => ({ publishTaskEvent: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: {}, pool: { query } }));
vi.mock("@/lib/realtime", () => ({ realtime: { publish: vi.fn(), subscribe: vi.fn() } }));
vi.mock("@/lib/billing/limits", () => ({ releaseHold }));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent }));

import { cancelQueuedTurn } from "../queue";

const input = { id: "task-q", userId: "u1", chatId: "c1" };
/** The statements issued, first line only, for readable assertions. */
const statements = () => query.mock.calls.map((c) => String(c[0]).trim().split("\n")[0].trim());

beforeEach(() => {
  vi.clearAllMocks();
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
});
