import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";

const enqueueTask = vi.fn();
const notifyTaskEnqueued = vi.fn();
vi.mock("@/lib/tasks/queue", () => ({
  enqueueTask: (...a: unknown[]) => enqueueTask(...a),
  notifyTaskEnqueued: (...a: unknown[]) => notifyTaskEnqueued(...a),
}));

const rows: Record<string, unknown> = {};
// The decision + its resume task are written in ONE transaction, so the mock has
// to model a transaction: `tx` carries the writes, `tx.rollback()` throws the way
// drizzle's does, and `db.transaction` rolls back and RETHROWS (drizzle's own
// semantics — the caller is what turns the rollback back into `false`).
const tx = {
  select: () => ({ from: () => ({ where: () => ({ limit: () => [rows.task] }) }) }),
  update: () => ({
    set: (v: unknown) => { rows.updated = v; return { where: () => ({ returning: () => rows.updateReturn ?? [] }) }; },
  }),
  rollback: () => { throw new TransactionRollbackError(); },
};
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => [rows.msg] }) }) }),
    }),
    transaction: async (cb: (t: typeof tx) => Promise<unknown>) => {
      try {
        return await cb(tx);
      } catch (e) {
        rows.rolledBack = true;
        throw e;
      }
    },
  },
}));

import { approveManageForUser } from "../authed";

const pendingApproval = () => ({
  chatId: "chat1", ownerId: "u1", projectId: null,
  metadata: { taskId: "t1", status: "awaiting_approval", parts: [
    { type: "tool-call", id: "c1", name: "manage", input: {}, approval: { id: "ap1" } }, // no `approved` yet
  ] },
});

describe("approveManageForUser — atomic single-use approval", () => {
  beforeEach(() => {
    enqueueTask.mockReset().mockResolvedValue({ id: "task-new", created: true });
    notifyTaskEnqueued.mockReset();
    rows.updated = undefined;
    rows.updateReturn = undefined;
    rows.rolledBack = false;
  });

  it("records the decision and enqueues a resume when the guarded update matches", async () => {
    rows.msg = pendingApproval();
    rows.task = { payload: { requestModel: "m", origin: undefined } };
    rows.updateReturn = [{ id: "m1" }]; // this caller won the transition
    const outcome = await approveManageForUser("u1", { messageId: "m1", approved: true });
    expect(outcome).toBe("applied");
    expect(enqueueTask).toHaveBeenCalledOnce();
    expect(enqueueTask.mock.calls[0][0].payload.resumeMessageId).toBe("m1");
    // Enqueued inside the transaction (2nd arg = tx), so the wake-up NOTIFY is the
    // caller's job AFTER the commit — otherwise a woken worker looks for a row no
    // other connection can see yet and goes back to its 5s poll.
    expect(enqueueTask.mock.calls[0][1]).toBe(tx);
    expect(notifyTaskEnqueued).toHaveBeenCalledWith("task-new");
    const parts = (rows.updated as { metadata: { parts: { approval?: { approved?: boolean } }[] } }).metadata.parts;
    expect(parts[0].approval?.approved).toBe(true);
  });

  it("is single-use: a racing second decision (guarded update matches 0 rows) does NOT enqueue a duplicate resume", async () => {
    rows.msg = pendingApproval(); // still looks undecided in this caller's read…
    rows.task = { payload: {} };
    rows.updateReturn = []; // …but the conditional update matched nothing — already decided
    // "gone", not "busy": nothing is left to decide, so a second tap can never help.
    const outcome = await approveManageForUser("u1", { messageId: "m1", approved: false });
    expect(outcome).toBe("gone");
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(notifyTaskEnqueued).not.toHaveBeenCalled();
  });

  it("rolls the decision back when the continuation folds into a pending turn", async () => {
    // A chat holds one queued turn; a follow-up typed while the approval sat
    // unanswered owns that slot, so the resume insert folds into it and carries no
    // resumeMessageId. Recording the approval anyway would strand the call while
    // the card claimed success — so the whole transaction has to come back off.
    rows.msg = pendingApproval();
    rows.task = { payload: {} };
    rows.updateReturn = [{ id: "m1" }];
    // "busy", not "gone": the call is still pending, so the card must stay tappable.
    enqueueTask.mockResolvedValue({ id: "incumbent", created: false });
    const outcome = await approveManageForUser("u1", { messageId: "m1", approved: true });
    expect(outcome).toBe("busy");
    expect(rows.rolledBack).toBe(true);
    expect(notifyTaskEnqueued).not.toHaveBeenCalled();
  });

  it("rolls the decision back when queuing the continuation THROWS", async () => {
    // The window the transaction exists to close: the decision is recorded, then the
    // insert fails (churn on the chat's one queued slot, a dropped connection). Before,
    // the approval stayed durable with no turn to act on it — and no retry could fix
    // it, because the guarded update only matches while the call is still undecided.
    rows.msg = pendingApproval();
    rows.task = { payload: {} };
    rows.updateReturn = [{ id: "m1" }];
    enqueueTask.mockRejectedValue(new Error("could not settle a turn"));
    await expect(approveManageForUser("u1", { messageId: "m1", approved: true })).rejects.toThrow("could not settle");
    expect(rows.rolledBack).toBe(true);
    expect(notifyTaskEnqueued).not.toHaveBeenCalled();
  });

  it("refuses as gone when the message isn't the caller's (no write, no resume)", async () => {
    rows.msg = { chatId: "chat1", ownerId: "someone-else", projectId: null, metadata: { parts: [] } };
    const outcome = await approveManageForUser("u1", { messageId: "m1", approved: true });
    expect(outcome).toBe("gone");
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
