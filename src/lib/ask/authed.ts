import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { messages, chats, tasks } from "@/lib/db/schema";
import { enqueueTask } from "@/lib/tasks/queue";
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
 * hand. Returns false when the message isn't the caller's / has no pending ask.
 */
export async function answerAskForUser(userId: string, d: AskDecision): Promise<boolean> {
  const [msg] = await db
    .select({ chatId: messages.chatId, ownerId: chats.userId, projectId: chats.projectId, metadata: messages.metadata })
    .from(messages).innerJoin(chats, eq(messages.chatId, chats.id))
    .where(eq(messages.id, d.messageId)).limit(1);
  if (!msg || msg.ownerId !== userId) return false;

  const meta = (msg.metadata ?? {}) as MessageMeta;
  const parts = (meta.parts ?? []) as StoredPart[];
  const call = parts.find(
    (p): p is Extract<StoredPart, { type: "tool-call" }> =>
      p.type === "tool-call" && !!p.answer && p.answer.value === undefined && (!d.toolCallId || p.id === d.toolCallId),
  );
  if (!call || !call.answer) return false;

  const value: AskAnswer = { action: d.action, values: d.values };
  call.answer = { form: call.answer.form, value };
  // Append the tool-result so the resume sees a complete call→result pair.
  parts.push({ type: "tool-result", id: call.id, name: call.name, output: value });
  await db.update(messages).set({ metadata: { ...meta, parts } }).where(eq(messages.id, d.messageId));

  const orig = meta.taskId
    ? ((await db.select({ payload: tasks.payload }).from(tasks).where(eq(tasks.id, meta.taskId)).limit(1))[0]?.payload as TaskPayload | null)
    : null;
  await enqueueTask({
    id: nanoid(), chatId: msg.chatId, userId,
    payload: {
      resumeMessageId: d.messageId, uiMessages: [],
      requestModel: orig?.requestModel, projectId: msg.projectId ?? undefined, origin: orig?.origin,
    } satisfies TaskPayload,
  });
  return true;
}

/** Placeholder — the real block-and-poll row writer arrives in the MCP
 *  elicitation phase (Task B3). Kept here so the shared answer route compiles. */
export async function answerElicitationForUser(_userId: string, _d: AskDecision): Promise<boolean> {
  return false;
}
