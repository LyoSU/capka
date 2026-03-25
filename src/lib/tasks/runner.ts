import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { tasks, messages, memories } from "@/lib/db/schema";
import { eventBus } from "@/lib/events";
import { extractMemories } from "@/lib/memory/extract";
import type { LanguageModel } from "ai";

// In-memory registry for abort control (single-instance; swap for Redis if scaling horizontally)
const running = new Map<string, AbortController>();

export function isTaskRunning(taskId: string): boolean {
  return running.has(taskId);
}

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

  // Fire-and-forget — runs independently of HTTP lifecycle
  (async () => {
    try {
      // Insert placeholder assistant message
      await db.insert(messages).values({
        id: msgId,
        chatId,
        role: "assistant",
        content: "",
        platform: "web",
        metadata: { taskId, status: "running", toolCalls: [], toolResults: [] },
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

      // Accumulated state
      let accText = "";
      const accToolCalls: { id: string; name: string; input: unknown }[] = [];
      const accToolResults: { id: string; name: string; output: unknown }[] = [];

      for await (const event of result.fullStream) {
        if (ac.signal.aborted) break;

        switch (event.type) {
          case "text-delta":
            accText += event.text;
            eventBus.emit(channel, {
              type: "task:text-delta",
              taskId, chatId, messageId: msgId,
              delta: event.text,
            });
            break;

          case "tool-call":
            accToolCalls.push({
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
            accToolResults.push({
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

          case "finish-step":
            // Progressive save — update assistant message in DB after each step
            await db.update(messages).set({
              content: accText,
              metadata: {
                taskId,
                status: "running",
                toolCalls: accToolCalls,
                toolResults: accToolResults,
              },
            }).where(eq(messages.id, msgId));
            break;
        }
      }

      // Final save
      const finalStatus = ac.signal.aborted ? "cancelled" : "completed";
      await db.update(messages).set({
        content: accText,
        metadata: {
          taskId,
          status: finalStatus,
          toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
          toolResults: accToolResults.length > 0 ? accToolResults : undefined,
        },
      }).where(eq(messages.id, msgId));

      await db.update(tasks).set({
        status: finalStatus,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));

      eventBus.emit(channel, { type: "task:finish", taskId, chatId, messageId: msgId, status: finalStatus });

      // Extract memories (fire-and-forget)
      if (accText) {
        extractMemories(model, accText, existingMemories.map((m) => m.content))
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
      const error = isAbort ? undefined : (e instanceof Error ? e.message : "Unknown error");

      // Update both task AND message status so UI doesn't stay stuck on "running"
      await Promise.all([
        db.update(tasks).set({ status, error, updatedAt: new Date() }).where(eq(tasks.id, taskId)).catch(() => {}),
        db.update(messages).set({ metadata: { taskId, status, error } }).where(eq(messages.id, msgId)).catch(() => {}),
      ]);
      eventBus.emit(channel, { type: "task:finish", taskId, chatId, messageId: msgId, status, error });
    } finally {
      running.delete(taskId);
      await closeMcp().catch(() => {});
    }
  })();
}
