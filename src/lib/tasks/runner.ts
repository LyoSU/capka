import { streamText, convertToModelMessages, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, UserModelMessage, TextPart, ImagePart, FilePart } from "ai";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { tasks, messages, memories } from "@/lib/db/schema";
import { eventBus } from "@/lib/events";
import { extractMemories } from "@/lib/memory/extract";
import { downloadFile } from "@/lib/sandbox/client";
import { MAX_NATIVE_FILE_BYTES, MAX_NATIVE_TOTAL_BYTES, type FileRef } from "@/lib/constants";
import type { StoredPart } from "@/lib/chat/contracts";

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
  nativeFiles?: FileRef[];
}

/** Max concurrent file downloads from sandbox */
const MAX_CONCURRENT_DOWNLOADS = 5;

/** Download files with bounded concurrency and total size budget */
async function downloadBounded(
  files: FileRef[],
  chatId: string,
): Promise<{ file: FileRef; buf: Buffer }[]> {
  const results: { file: FileRef; buf: Buffer }[] = [];
  let totalBytes = 0;

  for (let i = 0; i < files.length; i += MAX_CONCURRENT_DOWNLOADS) {
    if (totalBytes >= MAX_NATIVE_TOTAL_BYTES) break;

    const batch = files.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
    const settled = await Promise.allSettled(
      batch.map(async (file) => {
        const res = await downloadFile(chatId, file.name);
        return { file, buf: Buffer.from(await res.arrayBuffer()) };
      }),
    );
    for (const r of settled) {
      if (r.status === "rejected") {
        console.warn(`[task] failed to read file for native injection:`, r.reason);
        continue;
      }
      const { file, buf } = r.value;
      if (buf.length > MAX_NATIVE_FILE_BYTES) {
        console.log(`[task] skipping ${file.name} (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB limit)`);
        continue;
      }
      if (totalBytes + buf.length > MAX_NATIVE_TOTAL_BYTES) {
        console.log(`[task] skipping ${file.name} — would exceed 50MB aggregate limit`);
        continue;
      }
      totalBytes += buf.length;
      results.push(r.value);
    }
  }
  return results;
}

/** Read multimodal files from sandbox and inject as FilePart in the last user message */
async function injectNativeFiles(
  modelMessages: ModelMessage[],
  chatId: string,
  files: FileRef[],
): Promise<void> {
  if (files.length === 0) return;

  const lastUser = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
  if (!lastUser) return;

  const downloaded = await downloadBounded(files, chatId);
  if (downloaded.length === 0) return;

  const parts: FilePart[] = downloaded.map(({ file, buf }) => ({
    type: "file", mediaType: file.type, data: buf, filename: file.name,
  }));
  const totalBytes = downloaded.reduce((sum, { buf }) => sum + buf.length, 0);

  type UserPart = TextPart | ImagePart | FilePart;
  const existing: UserPart[] = typeof lastUser.content === "string"
    ? [{ type: "text", text: lastUser.content }]
    : [...lastUser.content];
  lastUser.content = [...existing, ...parts];

  console.log(`[task] injected ${parts.length} native file(s) (${(totalBytes / 1024).toFixed(0)}KB) into model message`);
}

export function startTask(opts: StartTaskOpts) {
  const { taskId, chatId, userId, model, tools, systemPrompt, uiMessages, closeMcp, existingMemories, nativeFiles } = opts;
  const channel = `user:${userId}`;
  const ac = new AbortController();
  running.set(taskId, ac);

  const msgId = nanoid();

  // Ordered parts — hoisted so catch can access accumulated state
  const parts: StoredPart[] = [];
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

      // Inject images/PDFs as native content so the model can see/read them directly
      let injectedNative = false;
      if (nativeFiles?.length) {
        await injectNativeFiles(modelMessages, chatId, nativeFiles);
        injectedNative = true;
      }

      const makeStream = () => streamText({
        model,
        ...(hasTools ? { tools: tools as never, stopWhen: stepCountIs(25) } : {}),
        system: systemPrompt,
        messages: modelMessages,
        abortSignal: ac.signal,
      });

      let result = makeStream();

      function appendText(delta: string) {
        const last = parts[parts.length - 1];
        if (last?.type === "text") last.text += delta;
        else parts.push({ type: "text", text: delta });
      }

      // Stream events — if model rejects vision, strip files and retry once
      let retried = false;
      const consume = async () => {
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
      };

      try {
        await consume();
      } catch (e) {
        // If model rejects vision input, strip file parts and retry once
        const msg = errMsg(e);
        const isVisionError = injectedNative && !retried &&
          (msg.includes("image input") || msg.includes("vision") || msg.includes("multimodal") || msg.includes("does not support"));
        if (isVisionError) {
          console.log("[task] model doesn't support vision — retrying without native files");
          retried = true;
          const lastUser = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
          if (lastUser && Array.isArray(lastUser.content)) {
            lastUser.content = lastUser.content.filter((p) => p.type !== "file");
          }
          result = makeStream();
          await consume();
        } else {
          throw e;
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
