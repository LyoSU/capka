import { eq, and, isNull, sql, TransactionRollbackError } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { messages, chats, tasks, pendingElicitations } from "@/lib/db/schema";
import { enqueueTask, notifyTaskEnqueued } from "@/lib/tasks/queue";
import { log } from "@/lib/log";
import type { MessageMeta, StoredPart } from "@/lib/chat/contracts";
import type { TaskPayload } from "@/lib/tasks/runner";
import type { AskAnswer } from "./types";

export type AskDecision = { messageId: string; toolCallId?: string; action: AskAnswer["action"]; values: AskAnswer["values"] };

/**
 * Record the user's answer to a suspended `ask` tool call and enqueue the turn's
 * continuation. Session/Telegram-authorized (the model can't reach this). Writes
 * `answer.value` onto the suspended tool-call part AND appends a matching
 * tool-result (its output is the AskAnswer), so convertToModelMessages rebuilds a
 * normal call→result pair and the SDK finishes the SAME turn with the answer in
 * hand. Same three outcomes as `approveManageForUser`: "gone" (not the caller's,
 * no pending ask, or already answered) is final; "busy" (the chat's one queued
 * slot is taken) is worth retrying.
 */
export async function answerAskForUser(userId: string, d: AskDecision): Promise<"applied" | "gone" | "busy"> {
  const [msg] = await db
    .select({ chatId: messages.chatId, ownerId: chats.userId, projectId: chats.projectId, metadata: messages.metadata })
    .from(messages).innerJoin(chats, eq(messages.chatId, chats.id))
    .where(eq(messages.id, d.messageId)).limit(1);
  if (!msg || msg.ownerId !== userId) return "gone";

  const meta = (msg.metadata ?? {}) as MessageMeta;
  const parts = (meta.parts ?? []) as StoredPart[];
  const call = parts.find(
    (p): p is Extract<StoredPart, { type: "tool-call" }> =>
      p.type === "tool-call" && !!p.answer && p.answer.value === undefined && (!d.toolCallId || p.id === d.toolCallId),
  );
  if (!call || !call.answer) return "gone";

  // Which rollback happened, for the caller's message. Set only on the retryable one.
  let refusal: "gone" | "busy" = "gone";

  const value: AskAnswer = { action: d.action, values: d.values };
  call.answer = { form: call.answer.form, value };
  // Append the tool-result so the resume sees a complete call→result pair.
  parts.push({ type: "tool-result", id: call.id, name: call.name, output: value });
  // Same shape as the manage approval path: the answer and the turn that acts on it
  // go in ONE transaction, so a throw or a restart between them can't leave an
  // answered question whose turn never resumes (a state no retry can rescue, since
  // the CAS below matches only while the ask is still unanswered).
  try {
    const taskId = await db.transaction(async (tx) => {
      // Single-use, atomic transition: the guard matches only while SOME ask part is
      // still unanswered, so two racing answers (double-submit, or web + Telegram) can't
      // both enqueue a resume — the first writes the value, the second matches 0 rows
      // and bails. Mirrors answerElicitationForUser's isNull(answer) guard.
      const applied = await tx.update(messages).set({ metadata: { ...meta, parts } })
        .where(and(
          eq(messages.id, d.messageId),
          sql`${messages.metadata} @? ${'$.parts[*] ? (exists(@.answer.form) && !exists(@.answer.value))'}::jsonpath`,
        ))
        .returning({ id: messages.id });
      if (applied.length === 0) tx.rollback();

      const orig = meta.taskId
        ? ((await tx.select({ payload: tasks.payload }).from(tasks).where(eq(tasks.id, meta.taskId)).limit(1))[0]?.payload as TaskPayload | null)
        : null;
      // A chat holds at most one QUEUED turn, so this insert folds into a pending one
      // when the user typed a follow-up while the question sat unanswered. The
      // incumbent carries no `resumeMessageId`, so the suspended `ask` would never
      // resume while the card reported success.
      const { id, created } = await enqueueTask({
        id: nanoid(), chatId: msg.chatId, userId,
        payload: {
          resumeMessageId: d.messageId, uiMessages: [],
          requestModel: orig?.requestModel, projectId: msg.projectId ?? undefined, origin: orig?.origin,
        } satisfies TaskPayload,
      }, tx);
      if (!created) {
        refusal = "busy";
        log.warn("ask continuation folded into a pending turn — answer rolled back", {
          messageId: d.messageId, chatId: msg.chatId,
        });
        tx.rollback();
      }
      return id;
    });
    await notifyTaskEnqueued(taskId);
    return "applied";
  } catch (e) {
    if (e instanceof TransactionRollbackError) return refusal;
    throw e;
  }
}

/**
 * Write the user's answer onto the `pending_elicitation` row an MCP tool's blocked
 * `execute` is polling (see mcp/elicitation). Unlike `ask`, there's no message part
 * or resume task — setting the row unblocks the handler, which returns the answer to
 * the MCP server and completes the tool call. Matched by messageId + owner + still
 * unanswered; returns false when no such row (already answered, or not the caller's).
 */
export async function answerElicitationForUser(userId: string, d: AskDecision): Promise<boolean> {
  const value: AskAnswer = { action: d.action, values: d.values };
  const rows = await db.update(pendingElicitations)
    .set({ answer: value })
    .where(and(
      eq(pendingElicitations.messageId, d.messageId),
      eq(pendingElicitations.userId, userId),
      isNull(pendingElicitations.answer),
    ))
    .returning({ id: pendingElicitations.id });
  return rows.length > 0;
}
