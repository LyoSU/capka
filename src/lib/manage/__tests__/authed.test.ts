import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionRollbackError } from "drizzle-orm";

const enqueueTask = vi.fn();
const notifyTaskEnqueued = vi.fn();
vi.mock("@/lib/tasks/queue", () => ({
  enqueueTask: (...a: unknown[]) => enqueueTask(...a),
  notifyTaskEnqueued: (...a: unknown[]) => notifyTaskEnqueued(...a),
}));

// The continuation is a paid turn, so it reserves a budget hold under its own task id
// before anything is written. The reservation's answer is what these tests steer.
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
// A turn settled here on Telegram gets the runner's failure message through its sink.
const makeDeliverySink = vi.fn();
const sinkFinish = vi.fn();
vi.mock("@/lib/tasks/delivery", () => ({ makeDeliverySink: (...a: unknown[]) => makeDeliverySink(...a) }));

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
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: () => [rows.msg] }) }),
        where: () => ({ limit: () => [rows.task] }),
      }),
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

import { convertToModelMessages, type UIMessage } from "ai";
import { BudgetExceededError, ValidationError } from "@/lib/errors";
import { toUIMessages } from "@/lib/chat/presenter";
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
    reserveBudget.mockReset().mockResolvedValue({ allowed: true, window: null, reason: null });
    releaseHold.mockReset().mockResolvedValue(undefined);
    resolveUserModelInfo.mockReset().mockResolvedValue({ isShared: true, modelId: "m", provider: "p", configId: "cfg" });
    take.mockReset().mockReturnValue({ ok: true, retryAfterSec: 0 });
    publishTaskEvent.mockReset().mockResolvedValue(undefined);
    sinkFinish.mockReset().mockResolvedValue(undefined);
    makeDeliverySink.mockReset().mockReturnValue({ finish: sinkFinish });
  });

  const heldTaskId = () => reserveBudget.mock.calls[0][0].taskId as string;

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
    expect(notifyTaskEnqueued).toHaveBeenCalledWith(heldTaskId());
    const parts = (rows.updated as { metadata: { parts: { approval?: { approved?: boolean } }[] } }).metadata.parts;
    expect(parts[0].approval?.approved).toBe(true);
    // The hold is reserved on the ORIGINAL turn's model, under the continuation's own
    // task id — and that task now owns it, so nothing releases it here.
    expect(resolveUserModelInfo).toHaveBeenCalledWith("u1", "m");
    expect(reserveBudget.mock.calls[0][0]).toMatchObject({ userId: "u1", onSharedKey: true, modelId: "m", configId: "cfg" });
    expect(enqueueTask.mock.calls[0][0].id).toBe(heldTaskId());
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("refuses over budget with nothing recorded and nothing queued", async () => {
    rows.msg = pendingApproval();
    rows.task = { payload: { requestModel: "m" } };
    rows.updateReturn = [{ id: "m1" }];
    reserveBudget.mockResolvedValue({ allowed: false, window: "d7", reason: "budget" });
    const err = await approveManageForUser("u1", { messageId: "m1", approved: true }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).window).toBe("d7");
    expect(rows.updated).toBeUndefined();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("refuses over the chat rate limit with the send's 429, nothing recorded and nothing reserved", async () => {
    rows.msg = pendingApproval();
    rows.task = { payload: { requestModel: "m" } };
    rows.updateReturn = [{ id: "m1" }];
    take.mockReturnValue({ ok: false, retryAfterSec: 6 });
    const err = await approveManageForUser("u1", { messageId: "m1", approved: true }).catch((e) => e);
    expect(take).toHaveBeenCalledWith("chat:u1");
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(rows.updated).toBeUndefined();
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("settles the turn as failed when the chat's connection was removed, instead of leaving an unresolvable card", async () => {
    rows.msg = pendingApproval();
    rows.task = { payload: { requestModel: "gone-cfg:m" } };
    rows.updateReturn = [{ id: "m1" }];
    resolveUserModelInfo.mockRejectedValue(new ValidationError(
      "This chat's model is no longer available — its connection was removed. Please choose another model.",
    ));
    const outcome = await approveManageForUser("u1", { messageId: "m1", approved: true });
    // Kept, but not "applied": the turn it would have resumed is over, and a caller
    // that said "Done" here would be contradicted by the failure right after it.
    expect(outcome).toBe("failed");
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
    // A web turn has no other channel to tell.
    expect(makeDeliverySink).not.toHaveBeenCalled();
  });

  it("gives an approved call that will never run a result, so the card settles and later turns stay valid", async () => {
    rows.msg = pendingApproval();
    rows.task = { payload: { requestModel: "gone-cfg:m" } };
    rows.updateReturn = [{ id: "m1" }];
    resolveUserModelInfo.mockRejectedValue(new ValidationError("This chat's model is no longer available — its connection was removed."));
    await approveManageForUser("u1", { messageId: "m1", approved: true });
    const settled = { id: "m1", role: "assistant", content: "", metadata: (rows.updated as { metadata: unknown }).metadata, createdAt: null, platform: null };
    const next = { id: "u2", role: "user", content: "hello again", metadata: null, createdAt: null, platform: null };
    const [reply] = toUIMessages([settled]);
    // Not "approval-responded" with approved=true — that state is the card's endless spinner.
    expect(reply.parts[0]).toMatchObject({ state: "output-available", approval: { approved: true }, output: { status: "error", code: "NOT_RUN" } });
    // The next send's history carries the call WITH its result (the same shape as an
    // approved call that ran), not a bare tool call ahead of the user's message.
    const model = await convertToModelMessages(toUIMessages([settled, next]) as unknown as UIMessage[]);
    const content = model.flatMap((m) => (Array.isArray(m.content) ? m.content : []) as { type: string; toolCallId?: string }[]);
    expect(content.filter((c) => c.type === "tool-call" || c.type === "tool-result"))
      .toEqual([expect.objectContaining({ type: "tool-call", toolCallId: "c1" }), expect.objectContaining({ type: "tool-result", toolCallId: "c1" })]);
    expect(content.at(-1)).toMatchObject({ type: "text", text: "hello again" });
  });

  it("records only the decision for a declined call, so its card keeps reading declined", async () => {
    rows.msg = pendingApproval();
    rows.task = { payload: { requestModel: "gone-cfg:m" } };
    rows.updateReturn = [{ id: "m1" }];
    resolveUserModelInfo.mockRejectedValue(new ValidationError("This chat's model is no longer available — its connection was removed."));
    await approveManageForUser("u1", { messageId: "m1", approved: false });
    const metadata = (rows.updated as { metadata: { parts: { type: string }[] } }).metadata;
    expect(metadata.parts.map((p) => p.type)).toEqual(["tool-call"]);
    const [reply] = toUIMessages([{ id: "m1", role: "assistant", content: "", metadata, createdAt: null, platform: null }]);
    expect(reply.parts[0]).toMatchObject({ state: "approval-responded", approval: { approved: false } });
  });

  it("tells a Telegram turn it failed, the way the runner would have", async () => {
    rows.msg = pendingApproval();
    const origin = { platform: "telegram", telegramChatId: 42, locale: "uk" };
    rows.task = { payload: { requestModel: "gone-cfg:m", origin } };
    rows.updateReturn = [{ id: "m1" }];
    resolveUserModelInfo.mockRejectedValue(new ValidationError("This chat's model is no longer available — its connection was removed."));
    await approveManageForUser("u1", { messageId: "m1", approved: true });
    expect(makeDeliverySink).toHaveBeenCalledWith(origin);
    expect(sinkFinish).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed", errorCategory: "model_unavailable", errorDetail: expect.stringMatching(/connection was removed/),
    }));
  });

  it("still surfaces an unexpected model-resolution error rather than settling the turn", async () => {
    rows.msg = pendingApproval();
    rows.task = { payload: {} };
    resolveUserModelInfo.mockRejectedValue(new Error("connection reset"));
    await expect(approveManageForUser("u1", { messageId: "m1", approved: true })).rejects.toThrow("connection reset");
    expect(rows.updated).toBeUndefined();
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
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
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
    // The incumbent carries its own hold; ours would hold the budget until the orphan sweep.
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
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
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
  });

  it("refuses as gone when the message isn't the caller's (no write, no resume)", async () => {
    rows.msg = { chatId: "chat1", ownerId: "someone-else", projectId: null, metadata: { parts: [] } };
    const outcome = await approveManageForUser("u1", { messageId: "m1", approved: true });
    expect(outcome).toBe("gone");
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
  });
});
