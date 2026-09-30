import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";

const enqueueTask = vi.fn();
const notifyTaskEnqueued = vi.fn();
vi.mock("@/lib/tasks/queue", () => ({
  enqueueTask: (...a: unknown[]) => enqueueTask(...a),
  notifyTaskEnqueued: (...a: unknown[]) => notifyTaskEnqueued(...a),
}));

// The resume is a paid turn and reserves a budget hold under its own task id first.
const reserveBudget = vi.fn();
const releaseHold = vi.fn();
vi.mock("@/lib/billing/limits", () => ({
  reserveBudget: (...a: unknown[]) => reserveBudget(...a),
  releaseHold: (...a: unknown[]) => releaseHold(...a),
}));
const resolveUserModelInfo = vi.fn();
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: (...a: unknown[]) => resolveUserModelInfo(...a),
}));
// The same per-user flood bucket a send spends from; the key is what these assert.
const take = vi.fn();
vi.mock("@/lib/rate-limit", () => ({ take: (...a: unknown[]) => take(...a) }));
const publishTaskEvent = vi.fn();
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent: (...a: unknown[]) => publishTaskEvent(...a) }));

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

import { BudgetExceededError, ValidationError } from "@/lib/errors";
import { answerAskForUser, answerElicitationForUser } from "../authed";

describe("answerAskForUser", () => {
  beforeEach(() => {
    enqueueTask.mockReset().mockResolvedValue({ id: "task-new", created: true });
    notifyTaskEnqueued.mockReset();
    rows.updated = undefined;
    rows.updateReturn = undefined;
    rows.rolledBack = false;
    reserveBudget.mockReset().mockResolvedValue({ allowed: true, window: null, reason: null });
    releaseHold.mockReset().mockResolvedValue(undefined);
    resolveUserModelInfo.mockReset().mockResolvedValue({ isShared: true, modelId: "m", provider: "p", configId: "cfg" });
    take.mockReset().mockReturnValue({ ok: true, retryAfterSec: 0 });
    publishTaskEvent.mockReset().mockResolvedValue(undefined);
  });

  const heldTaskId = () => reserveBudget.mock.calls[0][0].taskId as string;

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
    expect(notifyTaskEnqueued).toHaveBeenCalledWith(heldTaskId());
    // The tool-result was appended so the resume sees a complete call→result pair.
    const parts = (rows.updated as { metadata: { parts: { type: string }[] } }).metadata.parts;
    expect(parts.some((p) => p.type === "tool-result")).toBe(true);
    // Reserved on the original turn's model under the resume's own id, which owns it now.
    expect(resolveUserModelInfo).toHaveBeenCalledWith("u1", "m");
    expect(enqueueTask.mock.calls[0][0].id).toBe(heldTaskId());
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("refuses over budget with no answer recorded and nothing queued", async () => {
    rows.msg = pendingAsk();
    rows.task = { payload: { requestModel: "m" } };
    rows.updateReturn = [{ id: "m1" }];
    reserveBudget.mockResolvedValue({ allowed: false, window: "h5", reason: "budget" });
    await expect(
      answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(rows.updated).toBeUndefined();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("refuses over the chat rate limit with the send's 429, nothing recorded and nothing reserved", async () => {
    rows.msg = pendingAsk();
    rows.task = { payload: { requestModel: "m" } };
    rows.updateReturn = [{ id: "m1" }];
    take.mockReturnValue({ ok: false, retryAfterSec: 6 });
    const err = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } }).catch((e) => e);
    expect(take).toHaveBeenCalledWith("chat:u1");
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(rows.updated).toBeUndefined();
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("settles the turn as failed when the chat's connection was removed, instead of leaving an unresolvable card", async () => {
    rows.msg = pendingAsk();
    rows.task = { payload: { requestModel: "gone-cfg:m" } };
    rows.updateReturn = [{ id: "m1" }];
    resolveUserModelInfo.mockRejectedValue(new ValidationError(
      "This chat's model is no longer available — its connection was removed. Please choose another model.",
    ));
    const outcome = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } });
    expect(outcome).toBe("applied");
    // The decision is recorded AND the turn settled, in the runner's own friendly words.
    const meta = (rows.updated as { metadata: { status: string; error: string; errorCategory: string; errorDetail: string } }).metadata;
    expect(meta).toMatchObject({ status: "failed", errorCategory: "model_unavailable" });
    expect(meta.error).toMatch(/isn't available right now/);
    expect(meta.errorDetail).toMatch(/connection was removed/);
    // Nothing can run without a model, so nothing is held, queued or woken.
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(notifyTaskEnqueued).not.toHaveBeenCalled();
    expect(publishTaskEvent).toHaveBeenCalledWith("u1", expect.objectContaining({
      type: "task:finish", chatId: "chat1", messageId: "m1", status: "failed", error: meta.error,
    }));
  });

  it("still surfaces an unexpected model-resolution error rather than settling the turn", async () => {
    rows.msg = pendingAsk();
    rows.task = { payload: {} };
    resolveUserModelInfo.mockRejectedValue(new Error("connection reset"));
    await expect(answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } })).rejects.toThrow("connection reset");
    expect(rows.updated).toBeUndefined();
  });

  it("is single-use: a racing second answer whose guarded update matches 0 rows does NOT enqueue a duplicate resume", async () => {
    rows.msg = pendingAsk(); // still looks pending in this caller's read…
    rows.task = { payload: {} };
    rows.updateReturn = []; // …but the conditional update matched nothing — someone already answered
    const outcome = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "late" } });
    expect(outcome).toBe("gone");
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
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
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
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
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
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
