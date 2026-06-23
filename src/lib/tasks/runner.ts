import { streamText, convertToModelMessages, stepCountIs } from "ai";
import type { ModelMessage, UserModelMessage, TextPart, ImagePart, FilePart } from "ai";
import { eq, and, or, isNull, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { chats, messages, memories, projects, users } from "@/lib/db/schema";
import { publishTaskEvent } from "./events";
import { makeDeliverySink, type TaskOrigin, type StreamStatus } from "./delivery";
import { getTranslator } from "@/lib/i18n/translator";
import { describeStep } from "@/lib/chat/steps";
import { extractWorkspacePaths } from "@/lib/chat/artifacts";
import { loadActivePath } from "@/lib/chat/tree";
import { toUIMessages } from "@/lib/chat/presenter";
import { heartbeat, isCancelRequested, finalizeTask, absorbQueuedTasks } from "@/lib/tasks/queue";
import { resolveUserModelInfo } from "@/lib/providers/resolve";
import { providerNativeTools } from "@/lib/providers";
import { loadSandboxTools } from "@/lib/sandbox/tools";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { buildSystemPrompt, classifyFiles, findBlindModalities } from "@/lib/chat/prompt";
import { mimeToModality, type Modality } from "@/lib/providers/registry";
import { listAvailableSkills } from "@/lib/skills/service";
import { makeSkillTool } from "@/lib/skills/tool";
import { loadMcpTools } from "@/lib/mcp/load";
import { getSandboxNetworkDefault } from "@/lib/settings";
import { resolvePolicies, isUsable } from "@/lib/governance/policy";
import { recordUsage } from "@/lib/usage";
import { costUsd, type TokenUsage } from "@/lib/pricing";
import { extractMemories } from "@/lib/memory/extract";
import { generateChatTitle } from "@/lib/chat/title";
import { classifyLLMError, isModalityUnsupportedError, isReasoningUnsupportedError, TIMED_OUT_ERROR } from "@/lib/errors/friendly";
import { errorText } from "@/lib/errors/message";
import { downloadFile } from "@/lib/sandbox/client";
import { MAX_NATIVE_FILE_BYTES, MAX_NATIVE_TOTAL_BYTES, type FileRef } from "@/lib/constants";
import type { StoredPart } from "@/lib/chat/contracts";
import { log } from "@/lib/log";

const errMsg = (e: unknown) => errorText(e);

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
function reasoningOptions(provider: string): Record<string, Record<string, unknown>> | undefined {
  switch (provider) {
    case "anthropic":
      // The SDK sets max_tokens to fit the budget — don't cap it ourselves.
      return { anthropic: { thinking: { type: "enabled", budgetTokens: 4000 } } };
    case "openrouter":
      return { openrouter: { reasoning: { enabled: true, effort: "medium" } } };
    case "openai":
      // Responses API returns a visible reasoning summary.
      return { openai: { reasoningSummary: "auto" } };
    case "google":
      // Gemini: surface its thinking — includeThoughts streams a thought summary
      // into reasoning-delta. (Google Search grounding is a provider-executed
      // TOOL in this SDK, not a providerOption, so it's wired into the tool set
      // via providerNativeTools(), not here.)
      return { google: { thinkingConfig: { includeThoughts: true } } };
    case "litellm":
      // Namespace matches the provider `name` in getModel. reasoningEffort asks
      // the gateway's reasoning model to think; openai-compatible then parses the
      // streamed reasoning_content into reasoning-delta parts.
      return { litellm: { reasoningEffort: "medium" } };
    case "deepseek":
    case "mistral":
    case "xai":
    case "zhipu":
      // First-party OpenAI-compatible presets ride the same mechanism as litellm:
      // the namespace matches the provider `name` in getModel. A non-reasoning
      // model that rejects `reasoning_effort` trips the runner's
      // retry-without-reasoning path, so sending it unconditionally is safe.
      return { [provider]: { reasoningEffort: "medium" } };
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
 * Cap on a tool result's serialized size when streamed over realtime. Postgres
 * NOTIFY tops out at 8 KB, and the realtime layer replaces any oversized payload
 * with a `_truncated` marker that strips the body — including the `toolCallId`
 * the client needs to flip the step from "running" to "done". A loaded skill's
 * full text easily blows that cap, which is why such steps used to spin forever.
 * So we never ship a big result live: it is persisted to the DB and the client
 * fills it in on the next history load (every `task:finish` triggers one). The
 * realtime event then carries only what flips the step's state.
 */
const MAX_REALTIME_RESULT_BYTES = 6000;

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

const MAX_OUTPUT_FILES = 10;
const MAX_OUTPUT_FILE_BYTES = 45 * 1024 * 1024; // under Telegram's 50 MB document cap
const MAX_OUTPUT_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * The workspace files the agent's reply explicitly refers to by their
 * `/workspace/…` path — the same "artifacts" the web transcript surfaces as file
 * tiles. Delivered to channels that can't browse the sandbox (Telegram); we send
 * what the model points at, not every file it happened to touch. Bounded in
 * count and bytes, always best-effort.
 */
async function collectReferencedFiles(sessionKey: string, userId: string, text: string) {
  const paths = extractWorkspacePaths(text).slice(0, MAX_OUTPUT_FILES);
  const out: { name: string; data: Buffer }[] = [];
  let total = 0;
  for (const rel of paths) {
    try {
      const res = await downloadFile(sessionKey, rel, userId);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_OUTPUT_FILE_BYTES || total + buf.length > MAX_OUTPUT_TOTAL_BYTES) continue;
      total += buf.length;
      out.push({ name: rel.split("/").pop() || rel, data: buf });
    } catch (e) {
      // A referenced path might be a directory or only mentioned, not a real
      // downloadable file — skip it quietly.
      log.warn("referenced file download failed", { userId, file: rel, err: String(e) });
    }
  }
  return out;
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
async function prepareRun(userId: string, sessionKey: string, payload: TaskPayload, chatId: string) {
  // A project chat sees its project memory + user-global (unscoped) memory.
  // A standalone chat sees only user-global memory, so projects don't leak.
  const memoryFilter = payload.projectId
    ? and(eq(memories.userId, userId), or(eq(memories.projectId, payload.projectId), isNull(memories.projectId)))
    : and(eq(memories.userId, userId), isNull(memories.projectId));

  const [{ model, provider, modelId, modelInput, isShared }, project, userMemories, user, chat] = await Promise.all([
    resolveUserModelInfo(userId, payload.requestModel),
    payload.projectId
      ? db.select().from(projects).where(and(eq(projects.id, payload.projectId), eq(projects.userId, userId))).limit(1).then((r) => r[0])
      : Promise.resolve(undefined),
    db.select().from(memories).where(memoryFilter).orderBy(desc(memories.createdAt)).limit(50),
    db.select({ name: users.name, timezone: users.timezone, locale: users.locale })
      .from(users).where(eq(users.id, userId)).limit(1).then((r) => r[0]),
    db.select({ createdAt: chats.createdAt }).from(chats).where(eq(chats.id, chatId)).limit(1).then((r) => r[0]),
  ]);

  // Sandbox tools (execute_bash, read_file, …) + MCP connector tools (sub-project
  // B, namespaced mcp__<server>__<tool>) + the skill tool. Each piece has a stable
  // definition across runs, and the merge order is deterministic, so the
  // position-0 tools prefix stays cache-stable turn-to-turn.
  // Governance: an admin `deny` removes a skill/connector from the agent entirely.
  const policy = await resolvePolicies(userId, payload.projectId ?? null);
  // Egress: a project may force "bridge"; otherwise fall back to the org default.
  // The controller still gates bridge on SANDBOX_ALLOW_NETWORK.
  const networkMode = project?.sandboxNetwork === "bridge" ? "bridge" : await getSandboxNetworkDefault();
  const sandbox = await loadSandboxTools(userId, sessionKey, networkMode);
  const mcp = await loadMcpTools({
    userId,
    projectId: payload.projectId ?? null,
    sessionKey,
    isServerAllowed: (name) => isUsable(policy.effect("connector", name)),
  });
  const availableSkills = (await listAvailableSkills(userId, payload.projectId ?? null))
    .filter((s) => isUsable(policy.effect("skill", s.name)));
  const skillTool = makeSkillTool({ userId, sessionKey, projectId: payload.projectId ?? null });
  // Provider-executed tools (e.g. Gemini's Google Search grounding) join the
  // sandbox/MCP/skill tools; empty for providers without any.
  const tools = { ...sandbox.tools, ...mcp.tools, skill: skillTool, ...providerNativeTools(provider) };

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
    skills: availableSkills.map((s) => ({ name: s.name, description: s.description, body: s.body })),
    workspaceSnapshot,
    attachedFiles: payload.attachedFiles,
    provider,
    modelInput,
    user: user ? { name: user.name, timezone: user.timezone } : null,
    conversationStartedAt: chat?.createdAt ?? null,
    locale: user?.locale ?? payload.origin?.locale ?? null,
  });

  // Dispose both sandbox and MCP clients when the run ends.
  const closeAll = async () => { await Promise.allSettled([sandbox.close(), mcp.close()]); };
  return { model, provider, modelId, modelInput, isShared, tools, closeMcp: closeAll, prompt, userMemories };
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
  // One logger bound to this run's identity, so every line it emits carries
  // taskId/chatId/userId without each call site repeating them.
  const tlog = log.child({ taskId, chatId, userId });

  const ac = new AbortController();
  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    ac.abort();
  }, MAX_TASK_MS);
  const msgId = nanoid();
  const parts: StoredPart[] = [];
  // Join distinct segments with a blank line, not "". The model emits text (and
  // reasoning) in runs broken up by tool/reasoning steps, so each `text` part is
  // its own paragraph — the web renders them apart, but a channel that flattens
  // parts to one string (Telegram) would otherwise glue "…межі.Прав адміна…" into
  // a run-on wall. A blank line restores the paragraph the web already shows.
  const getFullText = () =>
    parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text.trim()).filter(Boolean).join("\n\n");
  const getReasoning = () =>
    parts.filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning")
      .map((p) => p.text.trim()).filter(Boolean).join("\n\n");
  let streamError: string | undefined;
  let closeMcp: (() => Promise<void>) | undefined;

  // Admin role gates the raw technical detail an error shows in-chat. Looked up
  // lazily and memoized — only failures need it, so a successful task pays nothing.
  let _isAdmin: boolean | undefined;
  const resolveIsAdmin = async (): Promise<boolean> => {
    if (_isAdmin === undefined) {
      const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
      _isAdmin = u?.role === "admin";
    }
    return _isAdmin;
  };

  // Outbound channel (e.g. Telegram). No-op for web — that UI streams over
  // realtime. Created up front so the catch path can still finalize it. We track
  // the live activity + tool count so the channel can show a status header while
  // streaming and a collapsed "✅ N tools · Ts" log once done.
  const sink = makeDeliverySink(payload.origin);
  // Same human-readable step labels the web UI uses ("Running a command…"),
  // localized to the originating channel's language.
  const stepsT = getTranslator(payload.origin?.locale, "steps");
  const startedAt = Date.now();
  let toolCount = 0;
  let currentStatus: StreamStatus;

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

    const { model, provider, modelId, modelInput, isShared, tools, closeMcp: close, prompt, userMemories } =
      await prepareRun(userId, sessionKey, payload, chatId);
    closeMcp = close;

    // Record an auxiliary (title/memory) LLM call's spend against the same key
    // and budget as the main turn. These fire-and-forget calls used to go
    // entirely unbilled, so cost analytics under-reported every turn.
    const recordAuxUsage = (u: TokenUsage) =>
      void recordUsage({ taskId, messageId: msgId, userId, provider, model: modelId, onSharedKey: isShared, usage: u });

    // Prompt caching, three tiers of system messages (see buildSystemPrompt):
    //  1. stable  — persona+sandbox+project+skills, identical for everyone →
    //     first ephemeral breakpoint, reused across all users/chats.
    //  2. session — name + conversation-start date, constant for this chat →
    //     its own breakpoint, reused on every turn of the conversation.
    //  3. volatile — memories/workspace/files, per-run, sent uncached last so
    //     churn never invalidates the cached prefixes.
    // `providerOptions.anthropic` is namespaced — non-Anthropic providers ignore it.
    const ephemeral = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;
    const systemMessages: ModelMessage[] = [
      { role: "system", content: prompt.stable, providerOptions: ephemeral },
    ];
    if (prompt.session) {
      systemMessages.push({ role: "system", content: prompt.session, providerOptions: ephemeral });
    }
    if (prompt.volatile) {
      systemMessages.push({ role: "system", content: prompt.volatile });
    }

    // The reply hangs off the last message of the branch we're answering (the
    // user message just sent, or the user turn being regenerated). Pointing the
    // chat at this leaf makes the new branch the active one immediately.
    let replyParentId = (payload.uiMessages ?? []).at(-1)?.id ?? null;
    // Batch a burst of queued follow-ups (web or Telegram) into one reply: answer
    // from the chat's CURRENT leaf — every message that piled up while we were
    // busy — and absorb the queued tasks those follow-ups created, carrying their
    // attachments along. Guarded to a USER leaf: a regenerate/edit leaves the
    // active leaf on an assistant reply, and that reply must hang off the
    // payload's user message instead, so we skip the override there.
    let extraAttachedFiles: FileRef[] = [];
    {
      const [row] = await db.select({ leaf: chats.activeLeafId }).from(chats).where(eq(chats.id, chatId)).limit(1);
      const leaf = row?.leaf ?? null;
      const leafRole = leaf
        ? (await db.select({ role: messages.role }).from(messages).where(eq(messages.id, leaf)).limit(1))[0]?.role
        : undefined;
      if (leaf && leafRole === "user") {
        replyParentId = leaf;
        const absorbed = await absorbQueuedTasks(chatId, taskId);
        extraAttachedFiles = absorbed.flatMap((t) => (t.payload as TaskPayload | null)?.attachedFiles ?? []);
      }
    }
    await db.insert(messages).values({
      id: msgId,
      chatId,
      parentId: replyParentId,
      role: "assistant",
      content: "",
      platform: payload.origin?.platform ?? "web",
      metadata: { taskId, status: "running", parts: [] },
    });
    await db.update(chats).set({ activeLeafId: msgId }).where(eq(chats.id, chatId));
    await publishTaskEvent(userId, { type: "task:start", taskId, chatId, messageId: msgId });

    // Show a "Thinking…" block immediately — before the model emits its first
    // token — so the channel reacts at once; reasoning text then streams into it.
    currentStatus = { kind: "thinking" };
    sink.push("", currentStatus);

    const hasTools = Object.keys(tools).length > 0;
    // Telegram chats are linear and serialized per chat, so a queued follow-up
    // runs only after the previous turn finished. Its payload was snapshotted at
    // enqueue time — when the prior reply was still empty — so rebuild the
    // conversation from the live tree here to feed the model the real history.
    // Rebuild the conversation from the live tree at run time (not the payload
    // snapshotted at enqueue): a queued/batched turn then sees the previous
    // reply's final content and every message folded into this turn. The path is
    // anchored at replyParentId, so regenerate/edit still answer their own leaf.
    let uiMessages = payload.uiMessages ?? [];
    if (replyParentId) {
      const path = await loadActivePath(chatId, replyParentId);
      if (path.length) uiMessages = toUIMessages(path.map((p) => p.node));
    }
    const modelMessages = await convertToModelMessages(uiMessages);

    let injectedNative = false;
    const turnFiles = [...(payload.attachedFiles ?? []), ...extraAttachedFiles];
    const { nativeFiles } = classifyFiles(turnFiles, provider, modelInput);
    if (nativeFiles.length) {
      await injectNativeFiles(modelMessages, sessionKey, userId, nativeFiles);
      injectedNative = true;
    }
    // Modalities of the files we DID inject — if the provider then rejects them at
    // runtime (the catalog over-claimed for a custom backend), the soft retry below
    // strips them and folds these into the notice so the user is still told.
    const nativeModalities = Array.from(
      new Set(nativeFiles.map((f) => mimeToModality(f.type)).filter((m): m is Modality => m !== null)),
    );
    // Media the chosen model can't take natively (e.g. an audio note on a text-only
    // model) — known upfront from gating. The model would otherwise answer blind, so
    // we surface a notice telling the user to switch to a capable model instead of
    // silently pretending the attachment was understood. A runtime rejection (the
    // retry) adds to this set.
    let blindModalities = findBlindModalities(turnFiles, provider, modelInput);

    // Reasoning is enabled optimistically; the fallback below clears this flag
    // and re-streams without it if the model rejects thinking/reasoning.
    const reasoning = reasoningOptions(provider);
    let useReasoning = reasoning !== undefined;
    const makeStream = () =>
      streamText({
        model,
        ...(hasTools ? { tools: tools as never, stopWhen: stepCountIs(25) } : {}),
        messages: [...systemMessages, ...modelMessages],
        ...(useReasoning && reasoning ? { providerOptions: reasoning as never } : {}),
        abortSignal: ac.signal,
      });

    let result = makeStream();

    // Spend on attempts we threw away (capability/empty-response retries). The
    // provider still billed those tokens, so they belong in the usage table for
    // accurate shared-key accounting — but NOT in the message's (i) popover,
    // which shows only the final attempt that produced the visible answer.
    // Captured from the OLD stream right before each retry replaces `result`.
    const discarded = { input: 0, output: 0, cached: 0 };
    let hadDiscard = false;
    const captureDiscarded = async () => {
      try {
        const u = await result.totalUsage;
        if (!u) return;
        const cached = u.inputTokenDetails?.cacheReadTokens ?? 0;
        const input = u.inputTokenDetails?.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cached);
        hadDiscard = true;
        discarded.input += input;
        discarded.output += u.outputTokens ?? 0;
        discarded.cached += cached;
      } catch { /* an errored/aborted stream may not report usage — best effort */ }
    };

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

    // Live-bubble delivery (Telegram): each answer run becomes its own bubble,
    // committed the moment a tool/reasoning step ends it. `lastSealedIndex` is the
    // index of the last `parts` entry already sent as a bubble.
    let lastSealedIndex = -1;
    const sealTrailingRun = async () => {
      const i = parts.length - 1;
      const p = parts[i];
      if (i !== lastSealedIndex && p && p.type === "text" && p.text.trim()) {
        lastSealedIndex = i;
        await sink.seal(p.text);
      }
    };
    // The still-open answer run — only the trailing, unsealed text part (earlier
    // runs are already committed bubbles). This is what the live draft previews
    // and what finish() persists as the final bubble.
    const openSegment = () => {
      const i = parts.length - 1;
      const p = parts[i];
      return i !== lastSealedIndex && p && p.type === "text" ? p.text : "";
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
      // Mirror progress to the outbound channel (Telegram): only the OPEN run,
      // since earlier runs are already committed as their own bubbles. Throttled
      // + coalesced inside the sink, so calling it on every flush is cheap.
      sink.push(openSegment(), currentStatus);
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
          case "reasoning-delta": {
            // Thinking resuming after answer text means that run is done — commit
            // it as its own bubble before the reasoning block takes over.
            const li = parts.length - 1;
            const tp = parts[li];
            if (li !== lastSealedIndex && tp && tp.type === "text" && tp.text.trim()) {
              currentStatus = { kind: "thinking", reasoning: getReasoning() };
              await flushBuffers();
              await sealTrailingRun();
            }
            appendReasoning(event.text);
            // Carry the live reasoning so the Telegram sink can fill a native
            // <tg-thinking> block (the web stream uses reasonBuf as before).
            currentStatus = { kind: "thinking", reasoning: getReasoning() };
            reasonBuf += event.text;
            scheduleFlush();
            break;
          }
          case "text-delta":
            // Answer is flowing — clear the transient "thinking/tool" header.
            currentStatus = undefined;
            appendText(event.text);
            textBuf += event.text;
            scheduleFlush();
            break;
          case "tool-input-start": {
            // The model has begun a tool call but its args haven't streamed in
            // yet. Surface the step at once (a spinner with a generic label) so
            // the user sees what's happening the moment it starts; `tool-call`
            // refines the label once the parsed args arrive. Not persisted — the
            // `tool-call` part below is the durable record. The narration before
            // it is a finished run, so seal it now (tool-call then won't re-seal).
            // `event.id` is the toolCallId on this chunk type.
            const step = describeStep(stepsT, event.toolName);
            currentStatus = { kind: "tool", label: step.activeLabel };
            await flushBuffers();
            await sealTrailingRun();
            await publishTaskEvent(userId, {
              type: "task:tool-input-start", taskId, chatId, messageId: msgId,
              toolCallId: event.id, toolName: event.toolName,
            });
            break;
          }
          case "tool-call": {
            toolCount += 1;
            const step = describeStep(stepsT, event.toolName, event.input);
            currentStatus = { kind: "tool", label: step.activeLabel, detail: step.detail };
            await flushBuffers();
            // The narration before a tool call is a finished run — send it as its
            // own bubble so the user sees it land before the tool runs.
            await sealTrailingRun();
            parts.push({ type: "tool-call", id: event.toolCallId, name: event.toolName, input: event.input });
            await publishTaskEvent(userId, {
              type: "task:tool-call", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, toolName: event.toolName, args: event.input,
            });
            break;
          }
          case "tool-result": {
            await flushBuffers();
            parts.push({ type: "tool-result", id: event.toolCallId, name: event.toolName, output: event.output });
            // The full output is in `parts` (saved to the DB at finish-step). Over
            // realtime we ship it only if it fits NOTIFY's budget; an oversized
            // body (e.g. a loaded skill) is dropped here so the small state-flip
            // event survives intact — the client backfills the body from the DB.
            const fits = Buffer.byteLength(JSON.stringify(event.output ?? null)) <= MAX_REALTIME_RESULT_BYTES;
            await publishTaskEvent(userId, {
              type: "task:tool-result", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, result: fits ? event.output : undefined,
            });
            break;
          }
          case "tool-error":
            await flushBuffers();
            parts.push({ type: "tool-error", id: event.toolCallId, name: event.toolName, error: errMsg(event.error) });
            await publishTaskEvent(userId, {
              type: "task:tool-result", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, result: { error: errMsg(event.error) }, isError: true,
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

    // Drop the native image/file parts the model rejected, but leave a text note
    // in their place — the model should KNOW the user attached something and say it
    // can't process it, not answer as if nothing was sent.
    const stripNativeFilesWithNote = () => {
      const lastUser = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
      if (!lastUser || !Array.isArray(lastUser.content)) return;
      const removed = lastUser.content.filter((p) => p.type === "file" || p.type === "image").length;
      lastUser.content = lastUser.content.filter((p) => p.type !== "file" && p.type !== "image");
      if (removed > 0) {
        lastUser.content.push({
          type: "text",
          text: `[The user attached ${removed === 1 ? "a file" : `${removed} files`}, but this model can't process that attachment type. Tell the user you received the attachment but can't read its contents, and help with whatever text was provided.]`,
        });
      }
    };

    // Capability errors can arrive two ways: thrown from the stream, or as a
    // `error` part (streamError) with the iterator finishing normally. Retry the
    // same way for both. Returns true if a retry was launched.
    const retryOnCapabilityError = async (err: unknown): Promise<boolean> => {
      if (injectedNative && !retried && isModalityUnsupportedError(err)) {
        tlog.info("attachment modality unsupported — retrying with files stripped + note");
        retried = true;
        streamError = undefined;
        parts.length = 0;
        lastSealedIndex = -1;
        stripNativeFilesWithNote();
        // The provider rejected what the catalog claimed it took — fold those
        // modalities into the notice so the user is told to switch models.
        blindModalities = Array.from(new Set([...blindModalities, ...nativeModalities]));
        await captureDiscarded();
        result = makeStream();
        await consume();
        return true;
      }
      if (useReasoning && isReasoningUnsupportedError(err)) {
        // Model can't reason — re-stream without the reasoning knobs. Reset parts
        // defensively so a retry can't duplicate output.
        tlog.info("reasoning unsupported — retrying without it");
        useReasoning = false;
        streamError = undefined;
        parts.length = 0;
        lastSealedIndex = -1;
        await captureDiscarded();
        result = makeStream();
        await consume();
        return true;
      }
      return false;
    };

    try {
      await consume();
      // Provider surfaced the error as a stream event, not a throw — same retry.
      if (streamError && !ac.signal.aborted) await retryOnCapabilityError(streamError);
    } catch (e) {
      if (!(await retryOnCapabilityError(e))) throw e;
    }

    // Retry once if the model produced no content.
    if (!ac.signal.aborted && !streamError) {
      const hasContent = parts.some((p) => (p.type === "text" && p.text.trim()) || p.type === "tool-call");
      if (!hasContent) {
        tlog.info("empty response — retrying once");
        parts.length = 0;
        lastSealedIndex = -1;
        await captureDiscarded();
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

    // Token usage + cost, computed once. Needed BOTH for the persisted message
    // metadata (so the (i) details survive a reload — elapsedMs and the usage
    // table are otherwise lost to the UI) and for the usage table below. Never
    // fatal: a failure here just omits the numbers from metadata. `inputTokens`
    // is the TOTAL input incl. cached reads, so split it — non-cached at the
    // input rate, cached reads at the discounted rate (avoids double-counting).
    let usageMeta: { input: number; output: number; cached: number } | undefined;
    let costMeta: number | null = null;
    try {
      const u = await result.totalUsage;
      if (u) {
        const cached = u.inputTokenDetails?.cacheReadTokens ?? 0;
        const input = u.inputTokenDetails?.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cached);
        usageMeta = { input, output: u.outputTokens ?? 0, cached };
        costMeta = await costUsd(modelId, {
          inputTokens: input, outputTokens: usageMeta.output, cachedInputTokens: cached,
        });
      }
    } catch (e) {
      tlog.error("usage compute failed", { err: String(e) });
    }

    await db.update(messages).set({
      content: getFullText(),
      metadata: {
        taskId, status: finalStatus, parts: parts.length > 0 ? parts : undefined,
        ...(failure ? { error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category } : {}),
        // Capability gap: the model couldn't natively take one of the attached
        // media types — flag it so the UI can nudge a model switch.
        ...(blindModalities.length ? { notice: { kind: "blind-modalities" as const, modalities: blindModalities } } : {}),
        // Tech details for the (i) popover — only on a clean completion.
        ...(finalStatus === "completed" ? {
          durationMs: Date.now() - startedAt,
          model: modelId,
          ...(usageMeta ? { usage: usageMeta } : {}),
          ...(costMeta != null ? { costUsd: costMeta } : {}),
        } : {}),
      },
    }).where(eq(messages.id, msgId));
    await finalizeTask(taskId, finalStatus, failure?.adminDetail ?? streamError ?? null);
    await publishTaskEvent(userId, { type: "task:finish", taskId, chatId, messageId: msgId, status: finalStatus, ...(failure ? { error: failure.userMessage } : {}) });
    // One structured line per finished run — the happy path used to leave no
    // trace in the logs (everything went to the DB), so "what happened with
    // task X" wasn't greppable for successful turns.
    tlog[finalStatus === "completed" ? "info" : "warn"]("task finished", {
      status: finalStatus,
      model: modelId,
      durationMs: Date.now() - startedAt,
      toolCount,
      ...(usageMeta ? { usage: usageMeta } : {}),
      ...(hadDiscard ? { discardedUsage: discarded } : {}),
      ...(costMeta != null ? { costUsd: costMeta } : {}),
      ...(streamError ? { error: streamError } : {}),
    });
    await sink.finish({
      // Only the final, unsealed run — earlier runs already arrived as bubbles.
      status: finalStatus, text: openSegment(), reasoning: getReasoning(),
      error: failure?.userMessage, errorDetail: failure?.adminDetail,
      isAdmin: failure ? await resolveIsAdmin() : false,
      toolCount, elapsedMs: Date.now() - startedAt,
      ...(blindModalities.length ? { blindModalities } : {}),
    });
    // Deliver any files the agent created/edited this run to the origin channel
    // (Telegram). Best-effort and only on success — never fail the task over it.
    if (finalStatus === "completed" && payload.origin) {
      try {
        const outFiles = await collectReferencedFiles(sessionKey, userId, getFullText());
        if (outFiles.length) await sink.sendFiles(outFiles);
      } catch (e) {
        tlog.warn("output file delivery failed", { err: String(e) });
      }
    }

    // Persist usage to the usage table (analytics). Reuses the split computed
    // above; recordUsage never throws on its own.
    if (usageMeta) {
      await recordUsage({
        taskId, messageId: msgId, userId, provider, model: modelId, onSharedKey: isShared,
        // Fold in the spend of any retried-then-discarded attempts (billing
        // truth), even though the (i) popover above shows only the final one.
        usage: {
          inputTokens: usageMeta.input + discarded.input,
          outputTokens: usageMeta.output + discarded.output,
          cachedInputTokens: usageMeta.cached + discarded.cached,
        },
        // No retries → reuse the figure already computed for the popover (skips a
        // second catalog lookup). With discarded spend folded in the totals
        // differ, so let recordUsage recompute the cost from the combined usage.
        costUsd: hadDiscard ? undefined : costMeta,
      });
    }

    // Extract long-term memories (fire-and-forget). Facts are about the USER, so
    // the user's own message is the primary signal — the assistant reply is only
    // context. (Feeding only the assistant output mined the wrong side of the turn.)
    // Gated on a clean completion (like the title): a cancelled/failed turn
    // shouldn't quietly spend tokens mining facts the user may have aborted.
    const lastUserText = (() => {
      const u = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
      if (!u) return "";
      if (typeof u.content === "string") return u.content;
      return u.content
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    })();
    if (finalStatus === "completed" && lastUserText.trim()) {
      extractMemories(
        model,
        { userText: lastUserText, assistantText: getFullText() },
        userMemories.map((m) => m.content),
        recordAuxUsage,
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
        .catch((e) => tlog.error("memory extraction failed", { err: String(e) }));
    }

    // Auto-title the chat on its FIRST completed turn. "First turn" = no prior
    // assistant message in the history — a migration-free sentinel for "new chat"
    // that also never clobbers a title the user renamed by hand on a later turn.
    // The slice-of-first-message placeholder set by /api/chat stays visible until
    // this lands, so the sidebar always shows *something* in the meantime.
    const isFirstTurn = !modelMessages.some((m) => m.role === "assistant");
    if (finalStatus === "completed" && isFirstTurn && lastUserText.trim()) {
      generateChatTitle(model, lastUserText, getFullText(), recordAuxUsage)
        .then(async (title) => {
          if (!title) return;
          await db.update(chats).set({ title }).where(eq(chats.id, chatId));
          await publishTaskEvent(userId, { type: "chat:title", chatId, title });
        })
        .catch((e) => tlog.error("chat title generation failed", { err: String(e) }));
    }
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    const status = isAbort && !deadlineHit ? "cancelled" : "failed";
    const failure = deadlineHit ? TIMED_OUT_ERROR : isAbort ? undefined : classifyLLMError(e);
    // This catch swallows the error to finalize gracefully, so the worker's
    // crash log never fires — record it here instead. A clean cancel is info.
    tlog[status === "cancelled" ? "info" : "error"]("task ended", {
      status, elapsedMs: Date.now() - startedAt, toolCount,
      ...(failure ? { error: failure.adminDetail } : { err: String(e) }),
    });
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
    await sink.finish({
      status, text: getFullText(), error: failure?.userMessage, errorDetail: failure?.adminDetail,
      isAdmin: failure ? await resolveIsAdmin() : false,
      toolCount, elapsedMs: Date.now() - startedAt,
    });
  } finally {
    clearTimeout(deadline);
    clearInterval(monitor);
    await closeMcp?.().catch(() => {});
  }
}
