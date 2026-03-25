import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { tasks, messages, memories } from "@/lib/db/schema";
import { eventBus } from "@/lib/events";
import { extractMemories } from "@/lib/memory/extract";
import type { LanguageModel } from "ai";

const running = new Map<string, AbortController>();
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

export function cancelTask(taskId: string): boolean {
  const ac = running.get(taskId);
  if (!ac) return false;
  ac.abort();
  return true;
}

interface StartTaskOpts {
  taskId: string;
  chatId: string;
  userId: string;
  model: LanguageModel;
  tools: Record<string, unknown>;
  systemPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uiMessages: any[];
  closeMcp: () => Promise<void>;
  existingMemories: { content: string }[];
}

export function startTask(opts: StartTaskOpts) {
  const { taskId, chatId, userId, model, tools, systemPrompt, uiMessages, closeMcp, existingMemories } = opts;
  const channel = `user:${userId}`;
  const ac = new AbortController();
  running.set(taskId, ac);

  const msgId = nanoid();

  // Ordered parts — hoisted so catch can access accumulated state
  type PartEntry =
    | { type: "text"; text: string }
    | { type: "tool-call"; id: string; name: string; input: unknown }
    | { type: "tool-result"; id: string; name: string; output: unknown }
    | { type: "tool-error"; id: string; name: string; error: string };
  const parts: PartEntry[] = [];
  const getFullText = () => parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
  let streamError: string | undefined;

  // Fire-and-forget — runs independently of HTTP lifecycle
  (async () => {
    try {
      await db.insert(messages).values({
        id: msgId,
        chatId,
        role: "assistant",
        content: "",
        platform: "web",
        metadata: { taskId, status: "running", parts: [] },
      });

      eventBus.emit(channel, { type: "task:start", taskId, chatId, messageId: msgId });

      const hasTools = Object.keys(tools).length > 0;
      const modelMessages = await convertToModelMessages(uiMessages);

      const result = streamText({
        model,
        ...(hasTools ? { tools: tools as never, stopWhen: stepCountIs(25) } : {}),
        system: systemPrompt,
        messages: modelMessages,
        abortSignal: ac.signal,
      });

      function appendText(delta: string) {
        const last = parts[parts.length - 1];
        if (last?.type === "text") last.text += delta;
        else parts.push({ type: "text", text: delta });
      }

      for await (const event of result.fullStream) {
        if (ac.signal.aborted) break;

        switch (event.type) {
          case "text-delta":
            appendText(event.text);
            eventBus.emit(channel, {
              type: "task:text-delta",
              taskId, chatId, messageId: msgId,
              delta: event.text,
            });
            break;

          case "tool-call":
            parts.push({
              type: "tool-call",
              id: event.toolCallId,
              name: event.toolName,
              input: event.input,
            });
            eventBus.emit(channel, {
              type: "task:tool-call",
              taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.input,
            });
            break;

          case "tool-result":
            parts.push({
              type: "tool-result",
              id: event.toolCallId,
              name: event.toolName,
              output: event.output,
            });
            eventBus.emit(channel, {
              type: "task:tool-result",
              taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId,
              result: event.output,
            });
            break;

          case "tool-error":
            parts.push({
              type: "tool-error",
              id: event.toolCallId,
              name: event.toolName,
              error: errMsg(event.error),
            });
            eventBus.emit(channel, {
              type: "task:tool-result",
              taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId,
              result: { error: errMsg(event.error) },
            });
            break;

          case "error":
            streamError = errMsg(event.error);
            break;

          case "finish-step":
            // Progressive save — update assistant message in DB after each step
            await db.update(messages).set({
              content: getFullText(),
              metadata: { taskId, status: "running", parts },
            }).where(eq(messages.id, msgId));
            break;
        }
      }

      // Final save
      const finalStatus = ac.signal.aborted ? "cancelled" : streamError ? "failed" : "completed";
      await db.update(messages).set({
        content: getFullText(),
        metadata: {
          taskId,
          status: finalStatus,
          parts: parts.length > 0 ? parts : undefined,
        },
      }).where(eq(messages.id, msgId));

      await db.update(tasks).set({
        status: finalStatus,
        ...(streamError ? { error: streamError } : {}),
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));

      eventBus.emit(channel, { type: "task:finish", taskId, chatId, messageId: msgId, status: finalStatus });

      // Extract memories (fire-and-forget)
      const text = getFullText();
      if (text) {
        extractMemories(model, text, existingMemories.map((m) => m.content))
          .then(async (newFacts) => {
            if (newFacts.length > 0) {
              await db.insert(memories).values(
                newFacts.map((content) => ({ id: nanoid(), userId, content, type: "fact" })),
              );
            }
          })
          .catch((e) => console.error("[task] memory extraction failed:", e));
      }
    } catch (e) {
      const isAbort = e instanceof Error && e.name === "AbortError";
      const status = isAbort ? "cancelled" : "failed";
      const error = isAbort ? undefined : errMsg(e);

      // Update both task AND message status — preserve any parts already accumulated
      await Promise.all([
        db.update(tasks).set({ status, error, updatedAt: new Date() }).where(eq(tasks.id, taskId)).catch(() => {}),
        db.update(messages).set({
          content: getFullText(),
          metadata: { taskId, status, error, parts: parts.length > 0 ? parts : undefined },
        }).where(eq(messages.id, msgId)).catch(() => {}),
      ]);
      eventBus.emit(channel, { type: "task:finish", taskId, chatId, messageId: msgId, status, error });
    } finally {
      running.delete(taskId);
      await closeMcp().catch(() => {});
    }
  })();
}
