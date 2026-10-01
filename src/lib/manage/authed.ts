import { createHash } from "node:crypto";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { users, messages, chats, tasks } from "@/lib/db/schema";
import { enqueueTask, notifyTaskEnqueued } from "@/lib/tasks/queue";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { reserveBudget, releaseHold } from "@/lib/billing/limits";
import { AppError, BudgetExceededError, ValidationError } from "@/lib/errors";
import { take } from "@/lib/rate-limit";
import { classifyLLMError } from "@/lib/errors/friendly";
import { publishTaskEvent } from "@/lib/tasks/events";
import { makeDeliverySink } from "@/lib/tasks/delivery";
import { log } from "@/lib/log";
import type { MessageMeta, StoredPart } from "@/lib/chat/contracts";
import type { TaskPayload } from "@/lib/tasks/runner";
import { buildRegistry } from "./controls";
import { applyPending, preview } from "./dispatch";
import { toManageInput } from "./tool";
import type { ManageContext, ManageResult } from "./types";

async function identity(
  userId: string,
  over?: { projectId?: string | null; sessionKey?: string; toolCallId?: string },
): Promise<ManageContext> {
  const [u] = await db.select({ role: users.role, locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1);
  return {
    userId,
    isAdmin: u?.role === "admin",
    projectId: over?.projectId ?? null,
    sessionKey: over?.sessionKey,
    locale: u?.locale ?? undefined,
    toolCallId: over?.toolCallId,
  };
}

/**
 * The ONE canonical human-authed apply path — apply a staged pending (only Undo
 * stages one now) AS the resolved user. Reached by the web `/api/manage/confirm`
 * endpoint and the Telegram callback, so the identity that authorizes it is built
 * one way and can't diverge between channels. The model never reaches this — only
 * a real session cookie / verified Telegram link resolves to a `userId`.
 */
export async function applyPendingForUser(userId: string, pendingId: string): Promise<ManageResult> {
  return applyPending(buildRegistry(), await identity(userId), pendingId);
}

/** Build the before→after preview for a `manage` tool call the SDK suspended for
 *  approval — resolved AS the user, so it reads their own role/locale. `input` is
 *  the suspended call's persisted tool args.
 *
 *  A workspace-path preview (e.g. `skill add {path}`) must read files in the run's
 *  sandbox, so it needs the session key. Callers supply it one of two ways:
 *   - the runner (Telegram approval) already holds `sessionKey`, so it passes it;
 *   - the web card passes the `messageId`, and we resolve the chat it belongs to
 *     (verifying ownership) → `sessionKey = projectId ?? chatId`.
 *  Without either, a path preview degrades to "can't read it now" instead of
 *  crashing on `sessionKey!` — but the common paths now inspect the real files. */
export async function previewManageForUser(
  userId: string,
  input: unknown,
  opts?: { sessionKey?: string; messageId?: string; toolCallId?: string },
): Promise<ReturnType<typeof preview>> {
  const mi = toManageInput((input ?? {}) as { action: string });
  if (!mi) return null;
  // The call this preview is FOR. A preview that resolves a moving target pins what it
  // showed against this exact suspended call, so the later apply runs that plan instead of
  // re-resolving one (manage/review-pin.ts). The pin is written under the PREVIEWING user,
  // and read back under the user the run belongs to, so a caller naming someone else's call
  // parks a row only they can reach — it never becomes the pin that apply spends.
  let over: { projectId?: string | null; sessionKey?: string; toolCallId?: string } = {
    toolCallId: opts?.toolCallId,
  };
  if (opts?.sessionKey) {
    over = { ...over, sessionKey: opts.sessionKey };
  } else if (opts?.messageId) {
    // Resolve the suspended message's chat, verifying the caller owns it, and derive
    // the sandbox session key the run used (projectId ?? chatId).
    const [m] = await db
      .select({ chatId: messages.chatId, ownerId: chats.userId, projectId: chats.projectId })
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(eq(messages.id, opts.messageId))
      .limit(1);
    if (m && m.ownerId === userId) {
      over = { ...over, projectId: m.projectId, sessionKey: m.projectId ?? m.chatId };
    }
  }
  return preview(buildRegistry(), await identity(userId, over), mi);
}

export type ApprovalDecision = { messageId: string; toolCallId?: string; approved: boolean; reason?: string };

/**
 * Record the user's decision on a suspended `manage` tool call and enqueue the
 * turn's continuation. This is the human-controlled half of native approval: the
 * session cookie / Telegram link authorizes it (the model can't), so a
 * prompt-injected agent that staged the call can never approve it. Marks the
 * persisted tool-call part with `{approved}` (so a reload reflects the decision)
 * then queues a resume task that re-opens the SAME assistant message — the AI SDK
 * re-runs the tool (approved) or the model sees the denial, and finishes the turn.
 * Three outcomes, because the two refusals are not the same to a user: "gone" —
 * not the caller's message, no pending call, a racing tap already decided it, or
 * the chat has moved past it (nothing to retry); "busy" — the decision stuck
 * nowhere because the chat's one queued slot is taken, which IS worth tapping again. Callers that show buttons
 * must keep them alive only for "busy". A fourth, "failed": the decision WAS
 * recorded, but the turn could not continue (no model left to run it) and was
 * settled here as failed — so it must not read as done. A user over their
 * shared-key budget gets a BudgetExceededError instead, and one over the chat rate
 * limit a 429 `RATE_LIMITED` AppError — both with nothing recorded.
 */
export async function approveManageForUser(userId: string, d: ApprovalDecision): Promise<"applied" | "gone" | "busy" | "failed"> {
  const [msg] = await db
    .select({ chatId: messages.chatId, ownerId: chats.userId, projectId: chats.projectId, leaf: chats.activeLeafId, metadata: messages.metadata })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .where(eq(messages.id, d.messageId))
    .limit(1);
  // A reply the chat has moved past is final — refuse before the rate limit or the budget is touched.
  // The transaction below re-checks under the chat lock, which is what guards a racing send.
  if (!msg || msg.ownerId !== userId || msg.leaf !== d.messageId) return "gone";

  const meta = (msg.metadata ?? {}) as MessageMeta;
  const parts = (meta.parts ?? []) as StoredPart[];
  // The decision must land on the exact call the user was shown. Three ways to
  // name it: the full toolCallId (web), a `#`-marked 12-hex sha256 prefix (a
  // Telegram callback, where the full id rarely fits 64 bytes), or — legacy
  // buttons already sent without a pin — no id, matching the first undecided
  // call. That last form is why the pinned forms exist: after a web approval
  // resumed the turn into a SECOND gated call, "first undecided" is a
  // different call than the one the stale card previews.
  const matches = (id: string) =>
    !d.toolCallId ||
    id === d.toolCallId ||
    (d.toolCallId.startsWith("#") && createHash("sha256").update(id).digest("hex").startsWith(d.toolCallId.slice(1)));
  const call = parts.find(
    (p): p is Extract<StoredPart, { type: "tool-call" }> =>
      p.type === "tool-call" && !!p.approval && p.approval.approved === undefined && matches(p.id),
  );
  if (!call || !call.approval) return "gone";

  // Which rollback happened, for the caller's message. Set only on the retryable one.
  let refusal: "gone" | "busy" = "gone";

  call.approval = { id: call.approval.id, approved: d.approved, ...(d.reason ? { reason: d.reason } : {}) };

  // Carry the original turn's model/project/origin so the continuation runs with
  // the same identity and delivers to the same channel (Telegram).
  const orig = meta.taskId
    ? ((await db.select({ payload: tasks.payload }).from(tasks).where(eq(tasks.id, meta.taskId)).limit(1))[0]?.payload as TaskPayload | null)
    : null;
  // The continuation runs the model again — approved or denied — so it is a paid
  // turn and passes the same shared-key budget gate as a send, resolved the way the
  // runner will resolve it. Reserved before anything is written: a refusal records
  // no decision, so the card stays live for when the window rolls over.
  // It also spends from the same per-user flood bucket as a send (same key, same
  // refusal), so a continuation is never a way around the chat route's rate limit.
  if (!take(`chat:${userId}`).ok) throw new AppError("Too many messages — please slow down.", 429, "RATE_LIMITED");
  const taskId = nanoid();
  // A connection an admin removed while the card waited leaves no model to run on.
  // Refusing would leave a card no tap can ever settle, so the decision is recorded
  // and the turn settled on the spot with the failure the runner gives a turn it
  // cannot resolve a model for — no hold and no task, since nothing can be spent.
  // Deliberately every ValidationError that resolution throws, not just the removed
  // connection: no provider or default model, the shared-key price cap, an unsafe
  // provider URL all refuse until an admin acts, and the runner classifies each the
  // same way (only the removed connection reads as "model unavailable").
  const model = await resolveUserModelInfo(userId, orig?.requestModel)
    .catch((e) => { if (e instanceof ValidationError) return { failure: classifyLLMError(e) }; throw e; });
  const failure = "failure" in model ? model.failure : null;
  // An approved call that will now never run still needs a result: without one the
  // card spins on "Applying…" forever, and every later turn feeds the model a tool
  // call with no result, which providers reject — the chat would fail on each send.
  // A declined call gets only its decision, as any declined call does: a result
  // here would take a gated call out of its "declined" card into the activity rail.
  if (failure && d.approved) {
    parts.push({ type: "tool-result", id: call.id, name: call.name, output: { status: "error", code: "NOT_RUN", reason: failure.category, error: `Not run. ${failure.userMessage}` } });
  }
  if (!("failure" in model)) {
    const { isShared, modelId, provider, configId } = model;
    const reservation = await reserveBudget({ userId, taskId, onSharedKey: isShared, modelId, provider, configId });
    if (!reservation.allowed) throw new BudgetExceededError(reservation.window ?? "m1");
  }
  // Released on every path that doesn't hand the hold to a created, committed task.
  let handedOff = false;

  // The decision and the turn that acts on it are ONE transaction. Recording the
  // decision first and queuing after left a window — a throw from either statement,
  // a dropped connection, a restart landing between them — where the approval was
  // durable but its continuation never existed. That message then sits in
  // `awaiting_approval` forever and no retry can rescue it, because the CAS below
  // matches only while the call is still undecided. Inside a transaction, "the
  // continuation can't be queued" is simply a rollback.
  try {
    await db.transaction(async (tx) => {
      // Single-use, atomic transition: the guard only matches while SOME approval part
      // is still undecided, so two racing approve/reject clicks (double-tap, or web +
      // Telegram at once) can't both win — the first flips it, the second matches 0
      // rows and bails WITHOUT enqueuing a duplicate resume. (answerElicitationForUser
      // already had this shape via isNull(answer); this brings approve in line.)
      // Only while the row is still the chat's leaf: a stale tab or an old Telegram
      // button would otherwise resume a reply the chat went past, mid-history. The
      // chat row is locked, so a send moving the leaf lands wholly before or after.
      const [chat] = await tx.select({ leaf: chats.activeLeafId }).from(chats).where(eq(chats.id, msg.chatId)).for("update");
      if (chat?.leaf !== d.messageId) tx.rollback();
      const settled = failure
        ? { status: "failed", error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category }
        : {};
      const applied = await tx.update(messages).set({ metadata: { ...meta, parts, ...settled } })
        .where(and(
          eq(messages.id, d.messageId),
          sql`${messages.metadata} @? ${'$.parts[*] ? (exists(@.approval) && !exists(@.approval.approved))'}::jsonpath`,
        ))
        .returning({ id: messages.id });
      if (applied.length === 0) tx.rollback();
      if (failure) return;

      // A chat holds at most one QUEUED turn, so this insert folds into an existing
      // one when the chat already has a pending turn (a Telegram follow-up typed while
      // the approval sat unanswered). Folding is right for user messages — they all
      // ride one reply — but fatal here: the incumbent carries no `resumeMessageId`, so
      // the approved call would never run while the card reported success.
      const { created } = await enqueueTask({
        id: taskId,
        chatId: msg.chatId,
        userId,
        payload: {
          resumeMessageId: d.messageId,
          requestModel: orig?.requestModel,
          projectId: msg.projectId ?? undefined,
          origin: orig?.origin,
        } satisfies TaskPayload,
      }, tx);
      if (!created) {
        refusal = "busy";
        log.warn("approval continuation folded into a pending turn — decision rolled back", {
          messageId: d.messageId, chatId: msg.chatId,
        });
        tx.rollback();
      }
    });
    // Committed with our own task created: it now owns the hold and settles it. And
    // only now does the row exist for anyone else, so only now is a worker worth
    // waking (enqueueTask holds the NOTIFY back inside a transaction).
    handedOff = true;
    // With no task to finish the turn, say it is finished ourselves: the open chat
    // reloads it, and the card gives way to the failure notice. A Telegram turn also
    // gets the failure message the runner would have delivered there.
    if (failure) {
      await publishTaskEvent(userId, {
        type: "task:finish", taskId, chatId: msg.chatId, messageId: d.messageId, status: "failed", error: failure.userMessage,
      }).catch(() => {});
      const origin = orig?.origin;
      if (origin) {
        await identity(userId).then(({ isAdmin }) => makeDeliverySink(origin).finish({
          status: "failed", text: "", error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category,
          isAdmin, toolCount: 0, elapsedMs: 0,
        })).catch((e) => log.warn("approval failure delivery failed", { messageId: d.messageId, err: String(e) }));
      }
      return "failed";
    }
    await notifyTaskEnqueued(taskId);
    return "applied";
  } catch (e) {
    // Our own rollback: nothing was recorded either way, so the card is safe to
    // leave live — `refusal` says whether tapping it again could ever help.
    if (e instanceof TransactionRollbackError) return refusal;
    throw e;
  } finally {
    if (!handedOff) await releaseHold(taskId);
  }
}
