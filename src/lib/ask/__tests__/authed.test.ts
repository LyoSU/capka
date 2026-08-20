import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";

const enqueueTask = vi.fn();
const notifyTaskEnqueued = vi.fn();
vi.mock("@/lib/tasks/queue", () => ({
  enqueueTask: (...a: unknown[]) => enqueueTask(...a),
  notifyTaskEnqueued: (...a: unknown[]) => notifyTaskEnqueued(...a),
}));

const rows: Record<string, unknown> = {};
// Both answerAskForUser and answerElicitationForUser guard the write and read its
// rowCount via `.set().where().returning()` — `updateReturn` is the rows the guarded
// update matched (empty = the pending item was already resolved). `answerAskForUser`
// additionally writes inside a TRANSACTION together with its resume task, so `tx`
// mirrors drizzle: `rollback()` throws, and `db.transaction` rethrows after undoing.
const writeApi = {
  select: () => ({ from: () => ({ where: () => ({ limit: () => [rows.task] }) }) }),
  update: () => ({
    set: (v: unknown) => { rows.updated = v; return { where: () => ({ returning: () => rows.updateReturn ?? [] }) }; },
  }),
};
const tx = { ...writeApi, rollback: () => { throw new TransactionRollbackError(); } };
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: () => [rows.msg] }) }),
        where: () => ({ limit: () => [rows.task] }),
      }),
    }),
    update: () => writeApi.update(),
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

import { answerAskForUser, answerElicitationForUser } from "../authed";

describe("answerAskForUser", () => {
  beforeEach(() => {
    enqueueTask.mockReset().mockResolvedValue({ id: "task-new", created: true });
    notifyTaskEnqueued.mockReset();
    rows.updated = undefined;
    rows.updateReturn = undefined;
    rows.rolledBack = false;
  });

  const pendingAsk = () => ({
    chatId: "chat1", ownerId: "u1", projectId: null,
    metadata: { taskId: "t1", status: "awaiting_answer", parts: [
      { type: "tool-call", id: "c1", name: "ask", input: {}, answer: { form: { fields: [{ id: "q", label: "Q?", kind: "text" }] } } },
    ] },
  });

  it("writes the answer + tool-result and enqueues a resume for an ask suspend", async () => {
    rows.msg = pendingAsk();
    rows.task = { payload: { requestModel: "m", origin: undefined } };
    rows.updateReturn = [{ id: "m1" }]; // the guarded update matched — this caller won
    const outcome = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } });
    expect(outcome).toBe("applied");
    expect(enqueueTask).toHaveBeenCalledOnce();
    expect(enqueueTask.mock.calls[0][0].payload.resumeMessageId).toBe("m1");
    // Enqueued inside the transaction, so the wake-up NOTIFY only fires after commit.
    expect(enqueueTask.mock.calls[0][1]).toBe(tx);
    expect(notifyTaskEnqueued).toHaveBeenCalledWith("task-new");
    // The tool-result was appended so the resume sees a complete call→result pair.
    const parts = (rows.updated as { metadata: { parts: { type: string }[] } }).metadata.parts;
    expect(parts.some((p) => p.type === "tool-result")).toBe(true);
  });

  it("is single-use: a racing second answer whose guarded update matches 0 rows does NOT enqueue a duplicate resume", async () => {
    rows.msg = pendingAsk(); // still looks pending in this caller's read…
    rows.task = { payload: {} };
    rows.updateReturn = []; // …but the conditional update matched nothing — someone already answered
    const outcome = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "late" } });
    expect(outcome).toBe("gone");
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("rolls the answer back when the continuation folds into a pending turn", async () => {
    // The chat's single queued slot is taken by a follow-up the user typed while the
    // question sat open, so the resume insert folds into it and loses resumeMessageId.
    // Keeping the answer recorded would strand the suspended call — take it back off.
    rows.msg = pendingAsk();
    rows.task = { payload: {} };
    rows.updateReturn = [{ id: "m1" }];
    // "busy", not "gone" — the question is still live, so Telegram says "try again"
    // instead of "expired", and the web card stays open.
    enqueueTask.mockResolvedValue({ id: "incumbent", created: false });
    const outcome = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } });
    expect(outcome).toBe("busy");
    expect(rows.rolledBack).toBe(true);
    expect(notifyTaskEnqueued).not.toHaveBeenCalled();
  });

  it("rolls the answer back when queuing the continuation THROWS", async () => {
    // The window a transaction closes and a compensating write cannot: the answer is
    // recorded, then the insert fails. Without the rollback the question reads as
    // answered with no turn to resume it, and the guarded update refuses every retry.
    rows.msg = pendingAsk();
    rows.task = { payload: {} };
    rows.updateReturn = [{ id: "m1" }];
    enqueueTask.mockRejectedValue(new Error("could not settle a turn"));
    await expect(
      answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } }),
    ).rejects.toThrow("could not settle");
    expect(rows.rolledBack).toBe(true);
    expect(notifyTaskEnqueued).not.toHaveBeenCalled();
  });

  it("refuses as gone when the message isn't the caller's", async () => {
    rows.msg = { chatId: "chat1", ownerId: "someone-else", metadata: { parts: [] } };
    const outcome = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: {} });
    expect(outcome).toBe("gone");
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("refuses as gone when there is no pending ask call", async () => {
    rows.msg = { chatId: "chat1", ownerId: "u1", projectId: null, metadata: { parts: [{ type: "text", text: "hi" }] } };
    const outcome = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: {} });
    expect(outcome).toBe("gone");
  });
});

describe("answerElicitationForUser", () => {
  beforeEach(() => { rows.updated = undefined; rows.updateReturn = undefined; });

  it("writes the answer onto the pending_elicitation row", async () => {
    rows.updateReturn = [{ id: "e1" }];
    const ok = await answerElicitationForUser("u1", { messageId: "m1", action: "submit", values: { name: "x" } });
    expect(ok).toBe(true);
    expect((rows.updated as { answer?: unknown }).answer).toEqual({ action: "submit", values: { name: "x" } });
  });

  it("returns false when no matching pending row (already answered / not owner)", async () => {
    rows.updateReturn = [];
    const ok = await answerElicitationForUser("u1", { messageId: "m1", action: "submit", values: {} });
    expect(ok).toBe(false);
  });
});
