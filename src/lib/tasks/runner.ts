import { streamText, convertToModelMessages, stepCountIs } from "ai";
import type { ModelMessage, UserModelMessage, TextPart, ImagePart, FilePart } from "ai";
import { eq, and, or, isNull, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { messages, memories, projects } from "@/lib/db/schema";
import { realtime } from "@/lib/realtime";
import { heartbeat, isCancelRequested, finalizeTask } from "@/lib/tasks/queue";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { loadSandboxTools } from "@/lib/sandbox/tools";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { buildSystemPrompt, classifyFiles } from "@/lib/chat/prompt";
import { recordUsage } from "@/lib/usage";
import { extractMemories } from "@/lib/memory/extract";
import { classifyLLMError } from "@/lib/errors/friendly";
import { downloadFile } from "@/lib/sandbox/client";
import { MAX_NATIVE_FILE_BYTES, MAX_NATIVE_TOTAL_BYTES, type FileRef } from "@/lib/constants";
import type { StoredPart } from "@/lib/chat/contracts";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Everything persisted on the task so any worker can run it without the
 *  originating request's memory. Model/tools/prompt are re-resolved here. */
export interface TaskPayload {
  requestModel?: string;
  projectId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uiMessages: any[];
  attachedFiles?: FileRef[];
}

export interface ClaimedTask {
  id: string;
  chat_id: string;
  user_id: string;
  payload: unknown;
}

/** Max concurrent file downloads from sandbox */
const MAX_CONCURRENT_DOWNLOADS = 5;

/** Download files with bounded concurrency and total size budget */
async function downloadBounded(
  files: FileRef[],
  sessionKey: string,
  userId: string,
): Promise<{ file: FileRef; buf: Buffer }[]> {
  const results: { file: FileRef; buf: Buffer }[] = [];
  let totalBytes = 0;

  for (let i = 0; i < files.length; i += MAX_CONCURRENT_DOWNLOADS) {
    if (totalBytes >= MAX_NATIVE_TOTAL_BYTES) break;

    const batch = files.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
    const settled = await Promise.allSettled(
      batch.map(async (file) => {
        const res = await downloadFile(sessionKey, file.name, userId);
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
  sessionKey: string,
  userId: string,
  files: FileRef[],
): Promise<void> {
  if (files.length === 0) return;

  const lastUser = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
  if (!lastUser) return;

  const downloaded = await downloadBounded(files, sessionKey, userId);
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

/** Re-resolve everything needed to run the task from its persisted payload.
 *  `sessionKey` is the project (shared folder) or the chat itself — see
 *  workspaceSessionKey. Memory is scoped to the project plus user-global facts. */
async function prepareRun(userId: string, sessionKey: string, payload: TaskPayload) {
  // A project chat sees its project memory + user-global (unscoped) memory.
  // A standalone chat sees only user-global memory, so projects don't leak.
  const memoryFilter = payload.projectId
    ? and(eq(memories.userId, userId), or(eq(memories.projectId, payload.projectId), isNull(memories.projectId)))
    : and(eq(memories.userId, userId), isNull(memories.projectId));

  const [{ model, provider, modelId }, project, userMemories] = await Promise.all([
    resolveUserModelInfo(userId, payload.requestModel),
    payload.projectId
      ? db.select().from(projects).where(and(eq(projects.id, payload.projectId), eq(projects.userId, userId))).limit(1).then((r) => r[0])
      : Promise.resolve(undefined),
    db.select().from(memories).where(memoryFilter).orderBy(desc(memories.createdAt)).limit(50),
  ]);

  const mcp = await loadSandboxTools(userId, sessionKey, project?.sandboxNetwork ?? undefined);

  // Workspace snapshot — runs inside the isolated Docker container, not the host.
  let workspaceSnapshot: string | undefined;
  try {
    const { execCommand } = await import("@/lib/sandbox/client");
    const ws = await execCommand(sessionKey, "find /workspace -maxdepth 3 -not -path '*/\\.*' | head -50", 5000).catch(() => null);
    if (ws?.stdout?.trim()) workspaceSnapshot = ws.stdout.trim();
  } catch { /* sandbox not ready yet */ }

  const systemPrompt = buildSystemPrompt({
    project,
    memories: userMemories,
    workspaceSnapshot,
    attachedFiles: payload.attachedFiles,
  });

  return { model, provider, modelId, tools: mcp.tools, closeMcp: mcp.close, systemPrompt, userMemories };
}

/**
 * Run an agent task to completion. Invoked by the worker for a claimed task
 * row — independent of any HTTP request, so it keeps running with the user's
 * tab closed. Streams via Postgres realtime, renews its lease via heartbeat,
 * cancels cooperatively through a DB flag, records usage, and finalizes the
 * task in the durable queue.
 */
export async function runAgentTask(task: ClaimedTask, workerId: string): Promise<void> {
  const taskId = task.id;
  const chatId = task.chat_id;
  const userId = task.user_id;
  const channel = `user:${userId}`;
  const payload = (task.payload ?? {}) as TaskPayload;
  // Shared project folder when the chat belongs to a project, else its own.
  const sessionKey = workspaceSessionKey({ id: chatId, projectId: payload.projectId ?? null });

  const ac = new AbortController();
  const msgId = nanoid();
  const parts: StoredPart[] = [];
  const getFullText = () =>
    parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
  let streamError: string | undefined;
  let closeMcp: (() => Promise<void>) | undefined;

  // Renew lease + poll for cooperative cancellation cross-process.
  const monitor = setInterval(() => {
    void (async () => {
      try {
        const alive = await heartbeat(taskId, workerId);
        if (!alive) { ac.abort(); return; } // lost lease (reconciled) → stop
        if (await isCancelRequested(taskId)) ac.abort();
      } catch { /* transient DB hiccup; next tick retries */ }
    })();
  }, 5000);

  try {
    // Cancelled while still queued — don't spin anything up.
    if (await isCancelRequested(taskId)) {
      await finalizeTask(taskId, "cancelled");
      await realtime.publish(channel, { type: "task:finish", taskId, chatId, status: "cancelled" });
      return;
    }

    const { model, provider, modelId, tools, closeMcp: close, systemPrompt, userMemories } =
      await prepareRun(userId, sessionKey, payload);
    closeMcp = close;

    await db.insert(messages).values({
      id: msgId,
      chatId,
      role: "assistant",
      content: "",
      platform: "web",
      metadata: { taskId, status: "running", parts: [] },
    });
    await realtime.publish(channel, { type: "task:start", taskId, chatId, messageId: msgId });

    const hasTools = Object.keys(tools).length > 0;
    const modelMessages = await convertToModelMessages(payload.uiMessages ?? []);

    let injectedNative = false;
    const { nativeFiles } = classifyFiles(payload.attachedFiles);
    if (nativeFiles.length) {
      await injectNativeFiles(modelMessages, sessionKey, userId, nativeFiles);
      injectedNative = true;
    }

    const makeStream = () =>
      streamText({
        model,
        ...(hasTools ? { tools: tools as never, stopWhen: stepCountIs(25) } : {}),
        system: systemPrompt,
        messages: modelMessages,
        abortSignal: ac.signal,
      });

    let result = makeStream();

    const appendText = (delta: string) => {
      const last = parts[parts.length - 1];
      if (last?.type === "text") last.text += delta;
      else parts.push({ type: "text", text: delta });
    };

    // Batch text deltas: one NOTIFY every ~100ms instead of per token, so a
    // long response is a handful of round-trips, not hundreds. Tool events
    // (rarer) publish immediately and flush any buffered text first to keep
    // ordering correct.
    let textBuf = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushText = async () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!textBuf) return;
      const delta = textBuf;
      textBuf = "";
      await realtime.publish(channel, { type: "task:text-delta", taskId, chatId, messageId: msgId, delta });
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; void flushText(); }, 100);
    };

    let retried = false;
    const consume = async () => {
      for await (const event of result.fullStream) {
        if (ac.signal.aborted) break;
        switch (event.type) {
          case "text-delta":
            appendText(event.text);
            textBuf += event.text;
            scheduleFlush();
            break;
          case "tool-call":
            await flushText();
            parts.push({ type: "tool-call", id: event.toolCallId, name: event.toolName, input: event.input });
            await realtime.publish(channel, {
              type: "task:tool-call", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, toolName: event.toolName, args: event.input,
            });
            break;
          case "tool-result":
            await flushText();
            parts.push({ type: "tool-result", id: event.toolCallId, name: event.toolName, output: event.output });
            await realtime.publish(channel, {
              type: "task:tool-result", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, result: event.output,
            });
            break;
          case "tool-error":
            await flushText();
            parts.push({ type: "tool-error", id: event.toolCallId, name: event.toolName, error: errMsg(event.error) });
            await realtime.publish(channel, {
              type: "task:tool-result", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, result: { error: errMsg(event.error) },
            });
            break;
          case "error":
            streamError = errMsg(event.error);
            break;
          case "finish-step":
            // Flush buffered text, progressive save + lease renewal per step.
            await flushText();
            await db.update(messages).set({
              content: getFullText(),
              metadata: { taskId, status: "running", parts },
            }).where(eq(messages.id, msgId));
            await heartbeat(taskId, workerId);
            break;
        }
      }
      await flushText();
    };

    try {
      await consume();
    } catch (e) {
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

    // Retry once if the model produced no content.
    if (!ac.signal.aborted && !streamError) {
      const hasContent = parts.some((p) => (p.type === "text" && p.text.trim()) || p.type === "tool-call");
      if (!hasContent) {
        console.log("[task] empty response — retrying once");
        parts.length = 0;
        result = makeStream();
        try {
          await consume();
        } catch (retryErr) {
          streamError = errMsg(retryErr);
        }
      }
    }

    const finalStatus = ac.signal.aborted ? "cancelled" : streamError ? "failed" : "completed";
    // Map any provider error to a friendly, role-aware shape: users see
    // `error`, admins can expand `errorDetail`. Raw text stays in tasks.error.
    const failure = streamError ? classifyLLMError(streamError) : undefined;

    await db.update(messages).set({
      content: getFullText(),
      metadata: {
        taskId, status: finalStatus, parts: parts.length > 0 ? parts : undefined,
        ...(failure ? { error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category } : {}),
      },
    }).where(eq(messages.id, msgId));
    await finalizeTask(taskId, finalStatus, streamError ?? null);
    await realtime.publish(channel, { type: "task:finish", taskId, chatId, messageId: msgId, status: finalStatus, ...(failure ? { error: failure.userMessage } : {}) });

    // Record token usage/cost (never fatal). `inputTokens` is the TOTAL input
    // including cached reads, so split it: charge non-cached at the input rate
    // and cached reads at the discounted cache rate (avoids double-counting).
    try {
      const usage = await result.totalUsage;
      if (usage) {
        const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
        const nonCachedInput =
          usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead);
        await recordUsage({
          taskId, messageId: msgId, userId, provider, model: modelId,
          usage: {
            inputTokens: nonCachedInput,
            outputTokens: usage.outputTokens ?? 0,
            cachedInputTokens: cacheRead,
          },
        });
      }
    } catch (e) {
      console.error("[task] usage capture failed:", e);
    }

    // Extract long-term memories (fire-and-forget).
    const text = getFullText();
    if (text) {
      extractMemories(model, text, userMemories.map((m) => m.content))
        .then(async (newFacts) => {
          if (newFacts.length > 0) {
            await db.insert(memories).values(
              newFacts.map((content) => ({
                id: nanoid(), userId, projectId: payload.projectId ?? null, content, type: "fact",
              })),
            );
          }
        })
        .catch((e) => console.error("[task] memory extraction failed:", e));
    }
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    const status = isAbort ? "cancelled" : "failed";
    const failure = isAbort ? undefined : classifyLLMError(e);
    await Promise.all([
      finalizeTask(taskId, status, failure?.adminDetail ?? null).catch(() => {}),
      db.update(messages).set({
        content: getFullText(),
        metadata: {
          taskId, status, parts: parts.length > 0 ? parts : undefined,
          ...(failure ? { error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category } : {}),
        },
      }).where(eq(messages.id, msgId)).catch(() => {}),
    ]);
    await realtime.publish(channel, { type: "task:finish", taskId, chatId, messageId: msgId, status, ...(failure ? { error: failure.userMessage } : {}) }).catch(() => {});
  } finally {
    clearInterval(monitor);
    await closeMcp?.().catch(() => {});
  }
}
