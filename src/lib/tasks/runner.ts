import { streamText, convertToModelMessages, stepCountIs } from "ai";
import type { ModelMessage, UserModelMessage, TextPart, ImagePart, FilePart } from "ai";
import { eq, and, or, isNull, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { messages, memories, projects } from "@/lib/db/schema";
import { publishTaskEvent } from "./events";
import { deliverTaskResult, type TaskOrigin } from "./delivery";
import { heartbeat, isCancelRequested, finalizeTask } from "@/lib/tasks/queue";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { loadSandboxTools } from "@/lib/sandbox/tools";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { buildSystemPrompt, classifyFiles } from "@/lib/chat/prompt";
import { listAvailableSkills } from "@/lib/skills/service";
import { makeSkillTool } from "@/lib/skills/tool";
import { loadMcpTools } from "@/lib/mcp/load";
import { resolvePolicies, isUsable } from "@/lib/governance/policy";
import { recordUsage } from "@/lib/usage";
import { extractMemories } from "@/lib/memory/extract";
import { classifyLLMError, isVisionUnsupportedError, isReasoningUnsupportedError, TIMED_OUT_ERROR } from "@/lib/errors/friendly";
import { downloadFile } from "@/lib/sandbox/client";
import { MAX_NATIVE_FILE_BYTES, MAX_NATIVE_TOTAL_BYTES, type FileRef } from "@/lib/constants";
import type { StoredPart } from "@/lib/chat/contracts";
import { log } from "@/lib/log";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Per-provider knobs that surface the model's reasoning ("thinking") in the
 * stream. WITHOUT these the provider reasons silently — or not at all — so the
 * SDK never emits `reasoning-delta` and the UI's thinking block stays empty.
 * Returns undefined for providers with no standard knob (e.g. Ollama).
 *
 * Applied optimistically: a model that can't reason rejects the request and the
 * runner retries once without this (see isReasoningUnsupportedError), so turning
 * it on "always" never breaks non-reasoning models like gpt-4o / claude-3.5.
 *
 * Visibility caveat: OpenAI only returns a reasoning *summary* over the
 * Responses API ("openai" provider). Through an OpenAI-compatible gateway
 * ("litellm", Chat Completions) the summary is visible only if the upstream
 * model echoes `reasoning_content` (Anthropic/DeepSeek do; OpenAI hides it).
 */
function reasoningConfig(provider: string):
  | { providerOptions: Record<string, Record<string, unknown>>; maxOutputTokens?: number }
  | undefined {
  switch (provider) {
    case "anthropic":
      // budgetTokens must stay below maxOutputTokens, so raise the output cap to
      // leave room for both the thought and the answer.
      return {
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 4000 } } },
        maxOutputTokens: 16000,
      };
    case "openrouter":
      return { providerOptions: { openrouter: { reasoning: { effort: "medium" } } } };
    case "openai":
      return { providerOptions: { openai: { reasoningSummary: "auto" } } };
    case "litellm":
      // Namespace matches the provider `name` in getModel. reasoningEffort asks
      // the gateway's reasoning model to think; openai-compatible then parses the
      // streamed reasoning_content into reasoning-delta parts.
      return { providerOptions: { litellm: { reasoningEffort: "medium" } } };
    default:
      return undefined;
  }
}

/** Everything persisted on the task so any worker can run it without the
 *  originating request's memory. Model/tools/prompt are re-resolved here. */
export interface TaskPayload {
  requestModel?: string;
  projectId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uiMessages: any[];
  attachedFiles?: FileRef[];
  /** Where to push the result besides the web UI (e.g. Telegram). */
  origin?: TaskOrigin;
}

export interface ClaimedTask {
  id: string;
  chat_id: string;
  user_id: string;
  payload: unknown;
}

/** Max concurrent file downloads from sandbox */
const MAX_CONCURRENT_DOWNLOADS = 5;

/**
 * Hard wall-clock ceiling for a single task. The lease/heartbeat only catches a
 * DEAD worker; a LIVE worker stuck on a hung tool or LLM call keeps renewing its
 * lease forever and would hold a concurrency slot indefinitely. This deadline
 * aborts such a run so the slot frees and the user gets a clear failure.
 */
const MAX_TASK_MS = 10 * 60_000;

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
        log.warn("native file read failed", { userId, err: String(r.reason) });
        continue;
      }
      const { file, buf } = r.value;
      if (buf.length > MAX_NATIVE_FILE_BYTES) {
        log.info("skipping native file: over per-file limit", { userId, file: file.name, bytes: buf.length });
        continue;
      }
      if (totalBytes + buf.length > MAX_NATIVE_TOTAL_BYTES) {
        log.info("skipping native file: over aggregate limit", { userId, file: file.name, bytes: buf.length });
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

  log.info("injected native files", { userId, count: parts.length, bytes: totalBytes });
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

  // Sandbox tools (execute_bash, read_file, …) + MCP connector tools (sub-project
  // B, namespaced mcp__<server>__<tool>) + the skill tool. Each piece has a stable
  // definition across runs, and the merge order is deterministic, so the
  // position-0 tools prefix stays cache-stable turn-to-turn.
  // Governance: an admin `deny` removes a skill/connector from the agent entirely.
  const policy = await resolvePolicies(userId, payload.projectId ?? null);
  const sandbox = await loadSandboxTools(userId, sessionKey, project?.sandboxNetwork ?? undefined);
  const mcp = await loadMcpTools({
    userId,
    projectId: payload.projectId ?? null,
    isServerAllowed: (name) => isUsable(policy.effect("connector", name)),
  });
  const availableSkills = (await listAvailableSkills(userId, payload.projectId ?? null))
    .filter((s) => isUsable(policy.effect("skill", s.name)));
  const skillTool = makeSkillTool({ userId, sessionKey, projectId: payload.projectId ?? null });
  const tools = { ...sandbox.tools, ...mcp.tools, skill: skillTool };

  // Workspace snapshot — runs inside the isolated Docker container, not the host.
  let workspaceSnapshot: string | undefined;
  try {
    const { execCommand } = await import("@/lib/sandbox/client");
    const ws = await execCommand(sessionKey, "find /workspace -maxdepth 3 -not -path '*/\\.*' | head -50", 5000).catch(() => null);
    if (ws?.stdout?.trim()) workspaceSnapshot = ws.stdout.trim();
  } catch { /* sandbox not ready yet */ }

  const prompt = buildSystemPrompt({
    project,
    memories: userMemories,
    skills: availableSkills.map((s) => ({ name: s.name, description: s.description })),
    workspaceSnapshot,
    attachedFiles: payload.attachedFiles,
  });

  // Dispose both sandbox and MCP clients when the run ends.
  const closeAll = async () => { await Promise.allSettled([sandbox.close(), mcp.close()]); };
  return { model, provider, modelId, tools, closeMcp: closeAll, prompt, userMemories };
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
  const payload = (task.payload ?? {}) as TaskPayload;
  // Shared project folder when the chat belongs to a project, else its own.
  const sessionKey = workspaceSessionKey({ id: chatId, projectId: payload.projectId ?? null });

  const ac = new AbortController();
  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    ac.abort();
  }, MAX_TASK_MS);
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
      await publishTaskEvent(userId, { type: "task:finish", taskId, chatId, status: "cancelled" });
      return;
    }

    const { model, provider, modelId, tools, closeMcp: close, prompt, userMemories } =
      await prepareRun(userId, sessionKey, payload);
    closeMcp = close;

    // Prompt caching: the stable prefix (persona + sandbox + project + skills)
    // carries an ephemeral cache breakpoint; the volatile suffix (memories,
    // workspace snapshot, attached files) follows it uncached so per-run churn
    // never invalidates the cached prefix. Two consecutive system messages.
    // `providerOptions.anthropic` is namespaced — non-Anthropic providers ignore it.
    const systemMessages: ModelMessage[] = [
      {
        role: "system",
        content: prompt.stable,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ];
    if (prompt.volatile) {
      systemMessages.push({ role: "system", content: prompt.volatile });
    }

    await db.insert(messages).values({
      id: msgId,
      chatId,
      role: "assistant",
      content: "",
      platform: payload.origin?.platform ?? "web",
      metadata: { taskId, status: "running", parts: [] },
    });
    await publishTaskEvent(userId, { type: "task:start", taskId, chatId, messageId: msgId });

    const hasTools = Object.keys(tools).length > 0;
    const modelMessages = await convertToModelMessages(payload.uiMessages ?? []);

    let injectedNative = false;
    const { nativeFiles } = classifyFiles(payload.attachedFiles);
    if (nativeFiles.length) {
      await injectNativeFiles(modelMessages, sessionKey, userId, nativeFiles);
      injectedNative = true;
    }

    // Reasoning is enabled optimistically; the fallback below clears this flag
    // and re-streams without it if the model rejects thinking/reasoning.
    const reasoning = reasoningConfig(provider);
    let useReasoning = reasoning !== undefined;
    const makeStream = () =>
      streamText({
        model,
        ...(hasTools ? { tools: tools as never, stopWhen: stepCountIs(25) } : {}),
        messages: [...systemMessages, ...modelMessages],
        ...(useReasoning && reasoning
          ? {
              providerOptions: reasoning.providerOptions as never,
              ...(reasoning.maxOutputTokens ? { maxOutputTokens: reasoning.maxOutputTokens } : {}),
            }
          : {}),
        abortSignal: ac.signal,
      });

    let result = makeStream();

    const appendText = (delta: string) => {
      const last = parts[parts.length - 1];
      if (last?.type === "text") last.text += delta;
      else parts.push({ type: "text", text: delta });
    };

    const appendReasoning = (delta: string) => {
      const last = parts[parts.length - 1];
      if (last?.type === "reasoning") last.text += delta;
      else parts.push({ type: "reasoning", text: delta });
    };

    // Batch text deltas: one NOTIFY every ~100ms instead of per token, so a
    // long response is a handful of round-trips, not hundreds. Tool events
    // (rarer) publish immediately and flush any buffered text first to keep
    // ordering correct.
    let textBuf = "";
    let reasonBuf = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushReasoning = async () => {
      if (!reasonBuf) return;
      const delta = reasonBuf;
      reasonBuf = "";
      await publishTaskEvent(userId, { type: "task:reasoning-delta", taskId, chatId, messageId: msgId, delta });
    };
    const flushText = async () => {
      if (!textBuf) return;
      const delta = textBuf;
      textBuf = "";
      await publishTaskEvent(userId, { type: "task:text-delta", taskId, chatId, messageId: msgId, delta });
    };
    // Flush reasoning before text so the live stream keeps the model's order
    // (it reasons, then answers). The persisted `parts` array is the source of
    // truth, so any minor live drift self-heals on the next save.
    const flushBuffers = async () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushReasoning();
      await flushText();
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; void flushBuffers(); }, 100);
    };

    let retried = false;
    const consume = async () => {
      for await (const event of result.fullStream) {
        if (ac.signal.aborted) break;
        switch (event.type) {
          case "reasoning-delta":
            appendReasoning(event.text);
            reasonBuf += event.text;
            scheduleFlush();
            break;
          case "text-delta":
            appendText(event.text);
            textBuf += event.text;
            scheduleFlush();
            break;
          case "tool-call":
            await flushBuffers();
            parts.push({ type: "tool-call", id: event.toolCallId, name: event.toolName, input: event.input });
            await publishTaskEvent(userId, {
              type: "task:tool-call", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, toolName: event.toolName, args: event.input,
            });
            break;
          case "tool-result":
            await flushBuffers();
            parts.push({ type: "tool-result", id: event.toolCallId, name: event.toolName, output: event.output });
            await publishTaskEvent(userId, {
              type: "task:tool-result", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, result: event.output,
            });
            break;
          case "tool-error":
            await flushBuffers();
            parts.push({ type: "tool-error", id: event.toolCallId, name: event.toolName, error: errMsg(event.error) });
            await publishTaskEvent(userId, {
              type: "task:tool-result", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, result: { error: errMsg(event.error) },
            });
            break;
          case "error":
            streamError = errMsg(event.error);
            break;
          case "finish-step":
            // Flush buffered text, progressive save + lease renewal per step.
            await flushBuffers();
            await db.update(messages).set({
              content: getFullText(),
              metadata: { taskId, status: "running", parts },
            }).where(eq(messages.id, msgId));
            await heartbeat(taskId, workerId);
            break;
        }
      }
      await flushBuffers();
    };

    try {
      await consume();
    } catch (e) {
      const isVisionError = injectedNative && !retried && isVisionUnsupportedError(e);
      if (isVisionError) {
        log.info("vision unsupported — retrying without native files", { taskId, chatId, userId });
        retried = true;
        const lastUser = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
        if (lastUser && Array.isArray(lastUser.content)) {
          lastUser.content = lastUser.content.filter((p) => p.type !== "file");
        }
        result = makeStream();
        await consume();
      } else if (useReasoning && isReasoningUnsupportedError(e)) {
        // Model can't reason — re-stream without the reasoning knobs. The error
        // fires at request build (before any delta), but reset parts defensively
        // so a retry can't duplicate output.
        log.info("reasoning unsupported — retrying without it", { taskId, chatId, userId });
        useReasoning = false;
        parts.length = 0;
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
        log.info("empty response — retrying once", { taskId, chatId, userId });
        parts.length = 0;
        result = makeStream();
        try {
          await consume();
        } catch (retryErr) {
          streamError = errMsg(retryErr);
        }
      }
    }

    const finalStatus = deadlineHit ? "failed" : ac.signal.aborted ? "cancelled" : streamError ? "failed" : "completed";
    // Map any provider error to a friendly, role-aware shape: users see
    // `error`, admins can expand `errorDetail`. Raw text stays in tasks.error.
    const failure = deadlineHit ? TIMED_OUT_ERROR : streamError ? classifyLLMError(streamError) : undefined;

    await db.update(messages).set({
      content: getFullText(),
      metadata: {
        taskId, status: finalStatus, parts: parts.length > 0 ? parts : undefined,
        ...(failure ? { error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category } : {}),
      },
    }).where(eq(messages.id, msgId));
    await finalizeTask(taskId, finalStatus, failure?.adminDetail ?? streamError ?? null);
    await publishTaskEvent(userId, { type: "task:finish", taskId, chatId, messageId: msgId, status: finalStatus, ...(failure ? { error: failure.userMessage } : {}) });
    if (payload.origin) {
      await deliverTaskResult(payload.origin, { status: finalStatus, text: getFullText(), error: failure?.userMessage });
    }

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
      log.error("usage capture failed", { taskId, err: String(e) });
    }

    // Extract long-term memories (fire-and-forget). Facts are about the USER, so
    // the user's own message is the primary signal — the assistant reply is only
    // context. (Feeding only the assistant output mined the wrong side of the turn.)
    const lastUserText = (() => {
      const u = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
      if (!u) return "";
      if (typeof u.content === "string") return u.content;
      return u.content
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    })();
    if (lastUserText.trim()) {
      extractMemories(
        model,
        { userText: lastUserText, assistantText: getFullText() },
        userMemories.map((m) => m.content),
      )
        .then(async (newFacts) => {
          if (newFacts.length > 0) {
            await db.insert(memories).values(
              newFacts.map((content) => ({
                id: nanoid(), userId, projectId: payload.projectId ?? null, content, type: "fact",
              })),
            );
          }
        })
        .catch((e) => log.error("memory extraction failed", { taskId, userId, err: String(e) }));
    }
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    const status = isAbort && !deadlineHit ? "cancelled" : "failed";
    const failure = deadlineHit ? TIMED_OUT_ERROR : isAbort ? undefined : classifyLLMError(e);
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
    await publishTaskEvent(userId, { type: "task:finish", taskId, chatId, messageId: msgId, status, ...(failure ? { error: failure.userMessage } : {}) }).catch(() => {});
    if (payload.origin) {
      await deliverTaskResult(payload.origin, { status, text: getFullText(), error: failure?.userMessage });
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(monitor);
    await closeMcp?.().catch(() => {});
  }
}
