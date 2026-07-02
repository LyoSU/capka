import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { users, messages, chats, tasks } from "@/lib/db/schema";
import { enqueueTask } from "@/lib/tasks/queue";
import type { MessageMeta, StoredPart } from "@/lib/chat/contracts";
import type { TaskPayload } from "@/lib/tasks/runner";
import { buildRegistry } from "./controls";
import { applyPending, preview } from "./dispatch";
import { toManageInput } from "./tool";
import type { ManageContext, ManageResult } from "./types";

async function identity(userId: string, over?: { projectId?: string | null; sessionKey?: string }): Promise<ManageContext> {
  const [u] = await db.select({ role: users.role, locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1);
  return {
    userId,
    isAdmin: u?.role === "admin",
    projectId: over?.projectId ?? null,
    sessionKey: over?.sessionKey,
    locale: u?.locale ?? undefined,
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
  opts?: { sessionKey?: string; messageId?: string },
): Promise<ReturnType<typeof preview>> {
  const mi = toManageInput((input ?? {}) as { action: string });
  if (!mi) return null;
  let over: { projectId?: string | null; sessionKey?: string } | undefined;
  if (opts?.sessionKey) {
    over = { sessionKey: opts.sessionKey };
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
      over = { projectId: m.projectId, sessionKey: m.projectId ?? m.chatId };
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
 * Returns false when the message isn't the caller's, or has no such pending call.
 */
export async function approveManageForUser(userId: string, d: ApprovalDecision): Promise<boolean> {
  const [msg] = await db
    .select({ chatId: messages.chatId, ownerId: chats.userId, projectId: chats.projectId, metadata: messages.metadata })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .where(eq(messages.id, d.messageId))
    .limit(1);
  if (!msg || msg.ownerId !== userId) return false;

  const meta = (msg.metadata ?? {}) as MessageMeta;
  const parts = (meta.parts ?? []) as StoredPart[];
  // A message has at most one call awaiting approval at a time (the composer
  // blocks while it's pending), so a channel that can't cheaply carry the
  // toolCallId (Telegram's 64-byte callback) may omit it and match the sole one.
  const call = parts.find(
    (p): p is Extract<StoredPart, { type: "tool-call" }> =>
      p.type === "tool-call" && !!p.approval && p.approval.approved === undefined && (!d.toolCallId || p.id === d.toolCallId),
  );
  if (!call || !call.approval) return false;

  call.approval = { id: call.approval.id, approved: d.approved, ...(d.reason ? { reason: d.reason } : {}) };
  // Single-use, atomic transition: the guard only matches while SOME approval part
  // is still undecided, so two racing approve/reject clicks (double-tap, or web +
  // Telegram at once) can't both win — the first flips it, the second matches 0
  // rows and bails WITHOUT enqueuing a duplicate resume. (answerElicitationForUser
  // already had this shape via isNull(answer); this brings approve in line.)
  const applied = await db.update(messages).set({ metadata: { ...meta, parts } })
    .where(and(
      eq(messages.id, d.messageId),
      sql`${messages.metadata} @? ${'$.parts[*] ? (exists(@.approval) && !exists(@.approval.approved))'}::jsonpath`,
    ))
    .returning({ id: messages.id });
  if (applied.length === 0) return false;

  // Carry the original turn's model/project/origin so the continuation runs with
  // the same identity and delivers to the same channel (Telegram).
  const orig = meta.taskId
    ? ((await db.select({ payload: tasks.payload }).from(tasks).where(eq(tasks.id, meta.taskId)).limit(1))[0]?.payload as TaskPayload | null)
    : null;
  await enqueueTask({
    id: nanoid(),
    chatId: msg.chatId,
    userId,
    payload: {
      resumeMessageId: d.messageId,
      uiMessages: [],
      requestModel: orig?.requestModel,
      projectId: msg.projectId ?? undefined,
      origin: orig?.origin,
    } satisfies TaskPayload,
  });
  return true;
}
