import { streamText, convertToModelMessages, stepCountIs } from "ai";
import type { ModelMessage, UserModelMessage, TextPart } from "ai";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { chats, messages, users } from "@/lib/db/schema";
import { publishTaskEvent } from "./events";
import { stripNul } from "./sanitize";
import { makeDeliverySink, type TaskOrigin, type StreamStatus } from "./delivery";
import { getTranslator } from "@/lib/i18n/translator";
import { describeStep } from "@/lib/chat/steps";
import { loadActivePath } from "@/lib/chat/tree";
import { toUIMessages } from "@/lib/chat/presenter";
import { sealOrphanToolCalls } from "@/lib/chat/tool-results";
import { heartbeat, isCancelRequested, finalizeTask, absorbQueuedTasks, trackAux } from "@/lib/tasks/queue";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { classifyFiles, findBlindModalities } from "@/lib/chat/prompt";
import { mimeToModality, type Modality } from "@/lib/providers/registry";
import { buildViewFileInjection } from "@/lib/sandbox/view-file";
import { askFormSchema, type AskForm } from "@/lib/ask/types";
import { buildModelContext, trimToRecent, type ContextRow } from "@/lib/chat/context/build";
import { contextBudget, COMPACT_THRESHOLD } from "@/lib/chat/context/budget";
import { contextManagementOptions, mergeProviderOptions } from "@/lib/chat/context/provider-edits";
import { stepSettings, foldReasoningIntoText } from "@/lib/chat/context/step-control";
import { compactConversation } from "@/lib/chat/context/compactor";
import { recordUsage, reconcileUsage } from "@/lib/usage";
import { releaseHold } from "@/lib/billing/limits";
import { costUsd, type TokenUsage } from "@/lib/pricing";
import { maintainMemoryDoc } from "@/lib/memory/store";
import { generateChatTitle } from "@/lib/chat/title";
import { classifyLLMError, isModalityUnsupportedError, isReasoningUnsupportedError, isReasoningEchoRejectedError, isContextOverflowError, isTransientError, TIMED_OUT_ERROR, PROVIDER_UNRESPONSIVE_ERROR, INTERRUPTED_ERROR } from "@/lib/errors/friendly";
import { delay } from "@ai-sdk/provider-utils";
import { buildResumeMessages, stitchOverlap } from "./resume";
import { StallWatchdog } from "./stall-watchdog";
import { errorText } from "@/lib/errors/message";
import { type FileRef } from "@/lib/constants";
import type { StoredPart, MessageMeta } from "@/lib/chat/contracts";
import { log } from "@/lib/log";
import { injectNativeFiles, collectReferencedFiles } from "./run-attachments";
import { prepareRun } from "./run-context";

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
  /** A continuation of a turn the user just approved/rejected on a `manage`
   *  approval card. When set, this task does NOT start a fresh reply: it CONTINUES
   *  the named assistant message (whose suspended tool call now carries the user's
   *  decision), so the AI SDK re-runs the tool (or sees the denial) and the model
   *  finishes the same turn — the tool-result + follow-up text append to this
   *  message. See `/api/manage/approve`. */
  resumeMessageId?: string;
  /** Set when this turn was fired by an automation — the finalize path reports
   *  the outcome back so consecutive failures can auto-disable it. */
  automationId?: string;
}

export interface ClaimedTask {
  id: string;
  chat_id: string;
  user_id: string;
  payload: unknown;
}

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

/**
 * Stream stall ceiling. A provider can accept the request and then go silent —
 * no tokens, not even reasoning — which, with only MAX_TASK_MS as a backstop,
 * left the user staring at a blank chat for 10 minutes before a generic timeout.
 * The stall watchdog aborts an attempt that produces nothing for this long while
 * we're waiting on the model (it's PAUSED during local tool execution, which is
 * legitimately quiet — see StallWatchdog). 60s is comfortably longer than any
 * real time-to-first-token, short enough that a hung gateway fails fast.
 */
const STREAM_IDLE_MS = 60_000;
/** Max recovery attempts (stall + transient) per turn before giving up with a
 *  clear "provider didn't respond" message. A transient gateway hiccup usually
 *  clears on the first retry; past 3 the model/provider is genuinely unhealthy. */
const MAX_RECOVERIES = 3;

/** Reactive context-overflow fallback: how many of the most recent conversation
 *  messages to keep when mechanically trimming a prompt the model rejected as too
 *  long. Generous enough to preserve the live exchange, small enough to fit. */
const EMERGENCY_KEEP_RECENT = 10;

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
  // Distinguishes an abort caused by losing our lease (crash/reconciliation —
  // finalize as "failed") from a cooperative user cancel (finalize "cancelled").
  let leaseLost = false;
  // Whether this turn ran on the user's OWN provider key (vs a shared admin key).
  // Drives error-detail visibility: an end user must see WHY their own key failed
  // (only they can fix it), while a shared-key failure's raw detail stays
  // admin-only. Set once prepareRun resolves the provider; defaults to false so a
  // failure before resolution stays admin-only.
  let ownKey = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    ac.abort();
  }, MAX_TASK_MS);
  // A native-approval continuation reuses the SUSPENDED assistant message (append
  // the execute-result + follow-up text to it); a normal turn mints a fresh reply.
  const resumeMessageId = payload.resumeMessageId ?? null;
  const msgId = resumeMessageId ?? nanoid();
  // Whether the assistant message row has been inserted yet. The insert happens
  // AFTER prepareRun (which resolves the model/provider). If prepareRun throws —
  // e.g. the chat's provider was disconnected or its model removed — there's no
  // row for the catch to write the failure onto, so the turn used to vanish with
  // no reply and no error (a silent dead-end that read as a hang). The catch
  // checks this flag and INSERTS a failed message instead, so the user always
  // sees what went wrong.
  let messageInserted = false;
  const parts: StoredPart[] = [];
  // Set when the AI SDK suspends a `manage` tool call for native approval: the
  // turn finalizes as "awaiting_approval" (non-terminal — no aux, no output-file
  // delivery), the suspended tool-call part is marked with its approvalId, and the
  // finished message carries Approve/Reject affordances (a card on web, inline
  // buttons on Telegram). The user's decision enqueues a resume continuation.
  let awaitingApproval: { approvalId: string; toolCallId: string } | undefined;
  // Set when the model calls the no-execute `ask` tool: the SDK ends the run
  // without a result, so the finalize path finalizes the turn as "awaiting_answer"
  // (non-terminal, like awaiting_approval — no aux, no output-file delivery) and
  // the question card / Telegram prompt can resume it with the user's answer.
  let awaitingAnswer: { toolCallId: string; form: AskForm } | undefined;
  // Per-message monotonic event counter. Stamped on every realtime event that
  // mutates/finalizes this reply (text/reasoning deltas, tool steps, reset,
  // finish). The persisted snapshot records the seq it covers (metadata.streamSeq),
  // so a client resuming mid-stream can tell covered/next/gapped deltas apart and
  // reconcile instead of appending onto a stale prefix. task:start is seq 0; the
  // first delta is seq 1. Bumped synchronously at each publish so NOTIFY order
  // (per-channel FIFO) matches seq order.
  let seq = 0;
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

  // Run identity + the LIVE usage accumulator, hoisted to the outer scope so the
  // catch path can reconcile REAL spend (not just release the hold) when a turn
  // is aborted/failed mid-stream after tokens were already billed on the shared
  // key — cancel, deadline, lost lease, or a thrown provider error. Undefined
  // until prepareRun resolves; the catch reconciles only when there's real usage.
  let runProvider: string | undefined;
  let runModelId: string | undefined;
  let runShared = false;
  const liveUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
  // The LAST step's raw prompt size (input incl. cached), overwritten (not summed)
  // on every finish-step — unlike liveUsage above, this is a snapshot of the final
  // call's context, not a running total across a multi-step tool-calling turn.
  let lastStepContextTokens = 0;
  const discarded = { input: 0, output: 0, cached: 0, cost: 0 };
  const orLive: { cost: number; upstreamProvider?: string; generationId?: string } = { cost: 0 };
  let discardedOrServed = false;

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
  // When the first answer token lands — the reasoning/tool phase ends here, so
  // `firstTextAt - startedAt` is the "reasoned for …" duration the UI shows
  // (mirrors the web's live stopwatch, which freezes when the answer begins).
  let firstTextAt: number | null = null;
  let toolCount = 0;
  let currentStatus: StreamStatus;

  // Renew lease + poll for cooperative cancellation cross-process.
  const monitor = setInterval(() => {
    void (async () => {
      try {
        const alive = await heartbeat(taskId, workerId);
        if (!alive) { leaseLost = true; ac.abort(); return; } // lost lease (reconciled) → stop
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

    const { model, provider, modelId, modelInput, isShared, configId, tools, viewFileBridge, closeMcp: close, prompt, contextLength, adminCap, toolSearch } =
      await prepareRun(userId, sessionKey, payload, chatId, msgId);
    closeMcp = close;
    ownKey = !isShared; // own-key failures are the user's to see + fix
    // Publish the run identity to the outer scope so the catch path can reconcile
    // real spend (H6) on an abort/throw mid-stream.
    runProvider = provider;
    runModelId = modelId;
    runShared = isShared;



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
    let extraAttachedFiles: FileRef[] = [];
    if (resumeMessageId) {
      // Approval continuation: the assistant message already exists (it's the chat
      // leaf) with its suspended tool call now carrying the user's decision. Load
      // its parts so this run APPENDS the execute-result + follow-up text to it,
      // and build the model context from the path ENDING at it — convertToModelMessages
      // turns that approval-responded tool part into a tool-approval-response, so
      // the SDK re-runs the tool (approved) or the model sees the denial. No new
      // row, no activeLeaf move.
      const [row] = await db.select({ metadata: messages.metadata, parentId: messages.parentId })
        .from(messages).where(eq(messages.id, resumeMessageId)).limit(1);
      const meta = (row?.metadata ?? {}) as MessageMeta;
      for (const p of meta.parts ?? []) parts.push(p);
      seq = meta.streamSeq ?? 0;
      replyParentId = resumeMessageId;
      messageInserted = true;
    } else {
      // Batch a burst of queued follow-ups (web or Telegram) into one reply: answer
      // from the chat's CURRENT leaf — every message that piled up while we were
      // busy — and absorb the queued tasks those follow-ups created, carrying their
      // attachments along. Guarded to a USER leaf: a regenerate/edit leaves the
      // active leaf on an assistant reply, and that reply must hang off the
      // payload's user message instead, so we skip the override there.
      const [row] = await db.select({ leaf: chats.activeLeafId }).from(chats).where(eq(chats.id, chatId)).limit(1);
      const leaf = row?.leaf ?? null;
      const leafRole = leaf
        ? (await db.select({ role: messages.role }).from(messages).where(eq(messages.id, leaf)).limit(1))[0]?.role
        : undefined;
      if (leaf && leafRole === "user") {
        replyParentId = leaf;
        const absorbed = await absorbQueuedTasks(chatId, taskId);
        extraAttachedFiles = absorbed.flatMap((t) => (t.payload as TaskPayload | null)?.attachedFiles ?? []);
        // Each absorbed follow-up reserved its own budget hold at enqueue; this
        // turn now answers them all and reconciles only its OWN hold to the real
        // cost, so release the absorbed ones — otherwise they leak as pending
        // holds and erode the user's budget until the 30-day window rolls.
        for (const t of absorbed) await releaseHold(t.id);
      }
      await db.insert(messages).values({
        id: msgId,
        chatId,
        parentId: replyParentId,
        role: "assistant",
        content: "",
        platform: payload.origin?.platform ?? "web",
        metadata: { taskId, status: "running", parts: [], streamSeq: 0 },
      });
      messageInserted = true;
      await db.update(chats).set({ activeLeafId: msgId }).where(eq(chats.id, chatId));
    }
    // A resume continues an existing message — seed task:start from the loaded seq
    // so the client keeps reconciling against the snapshot it already has, rather
    // than rewinding to 0 and dropping the appended deltas.
    await publishTaskEvent(userId, { type: "task:start", taskId, chatId, messageId: msgId, seq: resumeMessageId ? seq : 0 });

    // Show a "Thinking…" block immediately — before the model emits its first
    // token — so the channel reacts at once; reasoning text then streams into it.
    currentStatus = { kind: "thinking" };
    sink.push("", "", currentStatus);

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
      // Shape the path into the model's view: collapse history at the newest
      // compaction checkpoint into its summary (cache-stable — the checkpoint
      // doesn't move, so the prefix stays a cache hit between turns). The DB and
      // the UI transcript keep the full history; only the model's view is trimmed.
      if (path.length) uiMessages = toUIMessages(buildModelContext(path.map((p) => p.node) as ContextRow[], {}));
    }
    // Seal any tool call left dangling by an interrupted earlier turn (deadline,
    // lost worker, cancel — or a fork that COPIED such a turn). Without this the
    // SDK throws AI_MissingToolResultsError and the turn dies before it starts;
    // the orphan becomes a terminal "interrupted" result so the model can carry
    // on. Safe here — `uiMessages` is settled history, never the live reply.
    let modelMessages = await convertToModelMessages(sealOrphanToolCalls(uiMessages));

    // Cache breakpoint on the conversation tail. Providers with Anthropic-style
    // EXPLICIT caching (anthropic direct; Claude via OpenRouter, whose SDK reads
    // the same `anthropic` namespace as a fallback) otherwise cache only the
    // system prefix and re-bill the whole history at full input price on every
    // turn. The marker travels with the message OBJECT, so the compaction/memory
    // aux calls that reuse this array (buildAuxRequest) hit the same cache.
    // Implicit-caching providers (OpenAI/DeepSeek/Gemini) ignore the namespace.
    // Breakpoint budget (Anthropic max 4): stable + session + this + the
    // top-level auto one in makeStream = 4 — don't add a fifth.
    const markCacheTail = (msgs: ModelMessage[]) => {
      const last = msgs.at(-1);
      if (last) last.providerOptions = { ...last.providerOptions, ...ephemeral };
    };
    markCacheTail(modelMessages);

    let injectedNative = false;
    const turnFiles = [...(payload.attachedFiles ?? []), ...extraAttachedFiles];
    const { nativeFiles } = classifyFiles(turnFiles, provider, modelInput);
    if (turnFiles.length) {
      // One line an operator can grep after the fact to prove whether a given
      // attachment was even considered native for this provider+model, before
      // delivery narrows it further (see "injected native files").
      const nativeNames = new Set(nativeFiles.map((f) => f.name));
      tlog.info("attachments.classified", {
        provider,
        model: modelId,
        native: nativeFiles.map((f) => ({ name: f.name, type: f.type })),
        toolOnly: turnFiles.filter((f) => !nativeNames.has(f.name)).map((f) => ({ name: f.name, type: f.type })),
      });
    }
    let injectedFiles: FileRef[] = [];
    if (nativeFiles.length) {
      injectedFiles = await injectNativeFiles(modelMessages, sessionKey, userId, provider, nativeFiles);
      injectedNative = injectedFiles.length > 0;
    }
    // Ground-truth "attached files" prompt block, built HERE (not in
    // buildSystemPrompt) because delivery is only known after injection: only a
    // file whose bytes actually reached the model is announced as inline-readable.
    // A native-eligible file that couldn't be delivered (download failed, still
    // over cap after downscale, aggregate budget) is routed to the tool path
    // instead of being falsely promised visible — the root of the false-native
    // bug. Uncached volatile tier (own system message), so no cache-prefix cost.
    if (turnFiles.length) {
      const injectedNames = new Set(injectedFiles.map((f) => f.name));
      const lines = turnFiles.map(
        (f) => `  - /workspace/${f.name}${injectedNames.has(f.name) ? " (attached — you can see/read it directly)" : ""}`,
      );
      let block = `## User just attached these files:\n${lines.join("\n")}`;
      if (injectedFiles.length) {
        block += `\nFor files marked "attached", analyze the inline content you can already see directly — do NOT run sandbox tools to read, convert, or transcode them unless the user explicitly asks you to manipulate the file or your direct analysis fails.`;
      }
      if (turnFiles.some((f) => !injectedNames.has(f.name))) {
        block += `\nOpen the files without that note using tools as needed (e.g. view_file for images and PDFs).`;
      }
      systemMessages.push({ role: "system", content: block });
    }
    // Modalities of the files we actually DELIVERED — if the provider then rejects
    // them at runtime (the catalog over-claimed for a custom backend), the soft
    // retry below strips them and folds these into the notice so the user is still
    // told. Built from `injectedFiles`, not `nativeFiles`: a file that failed to
    // download or didn't fit the budget never reached the model, so its modality
    // must not be blamed for a runtime rejection.
    const nativeModalities = Array.from(
      new Set(injectedFiles.map((f) => mimeToModality(f.type)).filter((m): m is Modality => m !== null)),
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
    // Effective window (model ∩ admin cap) drives the provider-native edit's
    // trigger. Reused from the budget logic so the cap is honored here too.
    const effectiveLimit = contextBudget({ usedTokens: 0, modelContextLength: contextLength, adminCap: adminCap || null }).effectiveLimit;
    const ctxMgmt = contextManagementOptions(provider, effectiveLimit);
    // Stall detection runs per-attempt: `ac` is the task-wide signal (deadline,
    // cancel, lost lease); `attemptAc` aborts only the CURRENT stream when the
    // provider goes silent, so a retry can re-stream without the whole task
    // reading as cancelled. The model's signal is the union of both. A stalled
    // attempt sets `stalled` and is recovered up to MAX_RECOVERIES; once
    // exhausted, `stalledOut` makes finalization surface PROVIDER_UNRESPONSIVE.
    let attemptAc = new AbortController();
    let stalled = false;
    let stalledOut = false;
    let recoveries = 0;
    // A continuation re-stream appends these to the prompt (see resume()); empty
    // on the first attempt and on clean (capability/context) restarts.
    let resumeMessages: ModelMessage[] = [];
    // One-shot seam fix applied to the first text delta after a resume.
    let stitchNextDelta = false;
    let resumeTail = "";
    const watchdog = new StallWatchdog(STREAM_IDLE_MS, () => {
      stalled = true;
      tlog.warn("provider.stall", { model: modelId, attempt: recoveries, idleMs: STREAM_IDLE_MS });
      attemptAc.abort();
    });

    // Set once a backend 400s on echoed `reasoning_content` (see
    // retryOnCapabilityError). Hoisted above makeStream because prepareStep reads
    // it on the very first step — declaring it later would TDZ-throw.
    let reasoningStripped = false;
    const makeStream = () => {
      // reasoning + context-management + caching may all target the same provider
      // namespace (e.g. anthropic) — merge so none clobbers the others.
      const providerOptions = mergeProviderOptions(
        useReasoning ? (reasoning as Record<string, Record<string, unknown>>) : undefined,
        ctxMgmt as Record<string, Record<string, unknown>> | undefined,
        // Call-level cacheControl = Anthropic's TOP-LEVEL auto-breakpoint: the API
        // places it on the LAST block of each request, so every step of a tool
        // loop reads the previous step's cache instead of re-paying the growing
        // tail (the message-level tail marker above stays fixed at the last user
        // message all turn). Anthropic-only; other providers ignore the namespace.
        ephemeral as unknown as Record<string, Record<string, unknown>>,
      );
      return streamText({
        model,
        // prepareStep forces a text answer after FORCE_TEXT_AFTER_STEPS so a long
        // tool loop wraps up instead of hitting the hard step cap mid-tool. It
        // only tweaks toolChoice — never rewrites messages — so it can't break the
        // prompt cache mid-turn (see stepSettings). EXCEPTION: once a backend has
        // rejected echoed reasoning_content, we DO rewrite messages per-step to
        // fold reasoning into content — the offending echo is an intermediate
        // tool-loop message invisible to modelMessages, so this is the only place
        // to catch it. Breaking the cache is the accepted cost of not 400ing.
        ...(hasTools
          ? {
              tools: tools as never,
              // Progressive disclosure: when deferring, connector tools start
              // hidden (only the eager core + find_tool are active) and prepareStep
              // re-exposes whatever the model has discovered. `undefined` when not
              // deferring = all tools active (the SDK default).
              ...(toolSearch.defer ? { activeTools: toolSearch.activeToolNames() } : {}),
              stopWhen: stepCountIs(25),
              prepareStep: async ({ stepNumber, messages }) => {
                const base = reasoningStripped ? foldReasoningIntoText(messages) : messages;
                // BRIDGE: on a chat-completions transport the image can't ride the
                // view_file tool result, so append the rendered pages as a user
                // message for the one step right after the call (null otherwise, so
                // we don't override `messages` — and break the cache — on every step).
                let msgs = base;
                if (viewFileBridge) {
                  const inject = await buildViewFileInjection(messages, sessionKey, userId);
                  if (inject) msgs = [...base, inject];
                }
                return {
                  ...stepSettings(stepNumber),
                  ...(msgs !== messages ? { messages: msgs } : {}),
                  ...(toolSearch.defer ? { activeTools: toolSearch.activeToolNames() } : {}),
                };
              },
            }
          : {}),
        messages: [...systemMessages, ...modelMessages, ...resumeMessages],
        ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
        // Either signal aborts the stream; only `attemptAc` aborts are retryable.
        abortSignal: AbortSignal.any([ac.signal, attemptAc.signal]),
      });
    };

    let result = makeStream();

    // Usage accumulated LIVE from finish-step events — the source of truth.
    // `result.totalUsage` rejects on an aborted stream, so relying on it dropped
    // usage (and skipped billing) on every cancel/break. Per-step usages sum to
    // totalUsage on a clean run and survive an abort (steps emit usage before the
    // `abort` event).
    // input/output/cached drive billing; cacheWrite + reasoning are display-only
    // splits for the (i) popover (reasoning is already part of `output` for cost).
    // liveUsage / orLive / discarded are hoisted to the outer scope (so the catch
    // can reconcile real spend on an abort) — accumulated in place here.
    let hadDiscard = false;
    // Roll the current visible-answer usage into `discarded` when a retry wipes
    // `parts`. Stall/transient resumes KEEP their output, so they don't fold.
    const foldDiscarded = () => {
      if (liveUsage.input || liveUsage.output || liveUsage.cached) hadDiscard = true;
      discarded.input += liveUsage.input;
      discarded.output += liveUsage.output;
      discarded.cached += liveUsage.cached;
      // Capture the discarded attempt's real provider cost BEFORE the reset below
      // zeroes it — otherwise this spend is recomputed from the catalog and the
      // provider's authoritative figure is lost. Only meaningful when OpenRouter
      // actually served the attempt (orServed).
      if (orLive.generationId != null || orLive.upstreamProvider != null) {
        discarded.cost += orLive.cost;
        discardedOrServed = true;
      }
      liveUsage.input = 0;
      liveUsage.output = 0;
      liveUsage.cached = 0;
      liveUsage.cacheWrite = 0;
      liveUsage.reasoning = 0;
      // The discarded attempt's real cost is now banked in `discarded.cost`; the
      // next attempt re-reports its own. Reset routing too so the popover reflects
      // only the final generation.
      orLive.cost = 0;
      orLive.upstreamProvider = undefined;
      orLive.generationId = undefined;
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
      // ++seq synchronously before the await so concurrent flushes stay ordered.
      await publishTaskEvent(userId, { type: "task:reasoning-delta", taskId, chatId, messageId: msgId, delta, seq: ++seq });
    };
    const flushText = async () => {
      if (!textBuf) return;
      const delta = textBuf;
      textBuf = "";
      await publishTaskEvent(userId, { type: "task:text-delta", taskId, chatId, messageId: msgId, delta, seq: ++seq });
    };
    // Flush reasoning before text so the live stream keeps the model's order
    // (it reasons, then answers). The persisted `parts` array is the source of
    // truth, so any minor live drift self-heals on the next save.
    const flushBuffers = async () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flushReasoning();
      await flushText();
      // Mirror progress to the outbound channel (Telegram): the full answer so
      // far + the live reasoning, rendered as one animated draft preview.
      // Throttled + coalesced inside the sink, so calling it on every flush is cheap.
      sink.push(getFullText(), getReasoning(), currentStatus);
      // Persist progress so a client resuming mid-stream gets a fresh snapshot
      // (throttled inside saveSnapshot). Runs AFTER the flushes above, so the
      // snapshot's streamSeq covers every delta published this tick.
      await saveSnapshot();
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; void flushBuffers(); }, 100);
    };

    // Progressive persistence. WITHOUT this the DB only saved at finish-step, so
    // a single long answer (one step, no tools) sat as `parts: []` in the DB the
    // whole time it streamed — a client resuming mid-stream loaded an empty
    // prefix and saw the reply truncated. Throttled to ~1s (one UPDATE/sec per
    // task), and only ever called off a flush, so a quiet tool run adds no writes.
    let lastSaveAt = 0;
    const saveSnapshot = async (force = false) => {
      if (!force && Date.now() - lastSaveAt < 1000) return;
      lastSaveAt = Date.now();
      // Capture parts + content synchronously (structuredClone, so a token
      // appended during the DB await can't mutate what we persist).
      //
      // Consistency trap: `parts` is updated EAGERLY (appendText, per token)
      // while `seq` is bumped LAZILY (at publish/flush). During a flush's publish
      // await, consume can append more tokens — so `parts` here may be AHEAD of
      // `seq`, holding text that hasn't been published yet (it sits in
      // textBuf/reasonBuf). If we saved streamSeq=seq, the client would adopt
      // those un-published tokens from the snapshot AND then apply them again
      // when the next flush finally publishes them → duplicated text on resume.
      // So count the still-buffered runs that WILL publish next (reasoning then
      // text, each one ++seq) and fold them into streamSeq, so those upcoming
      // deltas land at seq <= streamSeq and the client ignores them as covered.
      const snapParts = structuredClone(parts);
      const snapSeq = seq + (reasonBuf ? 1 : 0) + (textBuf ? 1 : 0);
      const snapContent = getFullText();
      await db.update(messages).set({
        content: snapContent,
        metadata: { taskId, status: "running", parts: snapParts, streamSeq: snapSeq },
      }).where(eq(messages.id, msgId));
    };

    // Discard the partial reply before a retry re-streams from scratch
    // (capability/empty-response retries reset `parts`). Tells the client to drop
    // the abandoned attempt and resync, so retry deltas land on a clean slate
    // instead of being appended to the thrown-away text.
    const discardPartial = async () => {
      parts.length = 0;
      textBuf = "";
      reasonBuf = "";
      resumeMessages = [];
      stitchNextDelta = false;
      // Reset per-attempt metadata too: the discarded attempt's first-token time
      // and tool count must NOT carry into the surviving attempt, or the final
      // "reasoned for …" duration is measured against a thrown-away stream and
      // the "N tools" footer over-counts tools the user never saw land.
      firstTextAt = null;
      toolCount = 0;
      currentStatus = { kind: "thinking" };
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await publishTaskEvent(userId, { type: "task:reset", taskId, chatId, messageId: msgId, seq: ++seq });
    };

    let retried = false;
    const consume = async () => {
      // Arm the stall watchdog for this attempt: it fires only while we're waiting
      // on the model (paused during local tool runs) and is torn down whatever way
      // the loop ends (clean finish, abort event, or throw).
      watchdog.start();
      try {
      for await (const event of result.fullStream) {
        if (ac.signal.aborted) break;
        // A stall (or any abort) ends the stream via an "abort" event — stop
        // pulling at once so the retry path can take over.
        if (attemptAc.signal.aborted) break;
        // Any event means the provider is alive — reset the idle timer.
        watchdog.activity();
        switch (event.type) {
          case "reasoning-delta": {
            // Strip NUL at the single point model output enters `parts` (mirrors
            // the tool-result boundary): a NUL in reasoning/text would otherwise
            // ride into the jsonb metadata/text content write and throw
            // ("unsupported Unicode escape sequence"), losing the whole message.
            // Keeps the documented "parts never carry NUL" invariant true for
            // EVERY source, so the DB write, realtime publish, and Telegram sink
            // can all rely on it.
            const text = stripNul(event.text);
            appendReasoning(text);
            // Mark the thinking phase; the live reasoning text itself rides
            // getReasoning() into the sink's <tg-thinking> block (the web stream
            // uses reasonBuf as before).
            currentStatus = { kind: "thinking" };
            reasonBuf += text;
            scheduleFlush();
            break;
          }
          case "text-delta": {
            // First delta after a resume may re-emit the partial's tail — stitch it off.
            let text = stripNul(event.text);
            if (stitchNextDelta) { stitchNextDelta = false; text = stitchOverlap(resumeTail, text); }
            if (!text) break;
            // Answer is flowing — clear the transient "thinking/tool" header.
            if (firstTextAt == null) firstTextAt = Date.now();
            currentStatus = undefined;
            appendText(text);
            textBuf += text;
            scheduleFlush();
            break;
          }
          case "tool-input-start": {
            // The model has begun a tool call but its args haven't streamed in
            // yet. Surface the step at once (a spinner with a generic label) so
            // the user sees what's happening the moment it starts; `tool-call`
            // refines the label once the parsed args arrive. Not persisted — the
            // `tool-call` part below is the durable record.
            // `event.id` is the toolCallId on this chunk type.
            const step = describeStep(stepsT, event.toolName);
            currentStatus = { kind: "tool", label: step.activeLabel };
            await flushBuffers();
            await publishTaskEvent(userId, {
              type: "task:tool-input-start", taskId, chatId, messageId: msgId,
              toolCallId: event.id, toolName: event.toolName, seq: ++seq,
            });
            break;
          }
          case "tool-call": {
            toolCount += 1;
            // Strip NUL from the model-generated args before they enter `parts`
            // (a model can emit a literal NUL escape in a JSON string arg, which
            // is valid JSON but breaks the jsonb write). Completes the "parts never
            // carry NUL" invariant across every source.
            const input = stripNul(event.input);
            const step = describeStep(stepsT, event.toolName, input);
            currentStatus = { kind: "tool", label: step.activeLabel, detail: step.detail };
            await flushBuffers();
            parts.push({ type: "tool-call", id: event.toolCallId, name: event.toolName, input });
            await publishTaskEvent(userId, {
              type: "task:tool-call", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, toolName: event.toolName, args: input, seq: ++seq,
            });
            // Persist the call NOW (not just at finish-step): a tool can run for a
            // long time, and a client reconnecting mid-execution must get a
            // snapshot that already includes this step, or it reconciles in a loop
            // until the step ends. Tool events are rare, so a forced write is cheap.
            await saveSnapshot(true);
            if (event.toolName === "ask") {
              // No-execute tool → the SDK ends the run without a result. Mark the
              // call awaiting a human answer (mirrors tool-approval-request) so the
              // finalize path finalizes as "awaiting_answer" and the card / Telegram
              // prompt can resume it. Parse defensively — a malformed form still
              // suspends; the card just shows the raw fields.
              const parsed = askFormSchema.safeParse(input);
              const form = (parsed.success ? parsed.data : { fields: [] }) as AskForm;
              const callPart = parts.find((p) => p.type === "tool-call" && p.id === event.toolCallId);
              if (callPart?.type === "tool-call") callPart.answer = { form };
              awaitingAnswer = { toolCallId: event.toolCallId, form };
              await publishTaskEvent(userId, {
                type: "task:ask", taskId, chatId, messageId: msgId,
                toolCallId: event.toolCallId, form, seq: ++seq,
              });
              await saveSnapshot(true);
              break;
            }
            // The model is now waiting on OUR tool — pause the stall watchdog so a
            // legitimately slow command (a long sandbox run) isn't mistaken for a
            // hung provider. It resumes on the matching tool-result/tool-error.
            watchdog.enterTool();
            break;
          }
          case "tool-approval-request": {
            // Native human-in-the-loop: the SDK is asking the user to approve this
            // tool call before it runs (see the `manage` tool's needsApproval). The
            // stream will now END without an execute/result — mark the call
            // suspended and record the approvalId so the finalize path finalizes the
            // turn as "awaiting_approval" (not orphaned) and the user's card/button
            // can resume it. `tool-call` already pushed the part just above.
            watchdog.exitTool();
            const tc = event.toolCall;
            // `tool-call` above already pushed the part, but the approval event also
            // carries the full call — so find-or-create, then mark it suspended.
            let call = parts.find((p) => p.type === "tool-call" && p.id === tc.toolCallId);
            if (!call) {
              call = { type: "tool-call", id: tc.toolCallId, name: tc.toolName, input: stripNul(tc.input) };
              parts.push(call);
            }
            if (call.type === "tool-call") call.approval = { id: event.approvalId };
            awaitingApproval = { approvalId: event.approvalId, toolCallId: tc.toolCallId };
            await flushBuffers();
            await publishTaskEvent(userId, {
              type: "task:tool-approval", taskId, chatId, messageId: msgId,
              toolCallId: tc.toolCallId, approvalId: event.approvalId, seq: ++seq,
            });
            await saveSnapshot(true);
            break;
          }
          case "tool-result": {
            watchdog.exitTool(); // tool returned — back to waiting on the model
            await flushBuffers();
            // Trust boundary: a tool can return raw binary (e.g. a PNG dumped as
            // `output.content`) whose NUL bytes Postgres rejects in both `jsonb`
            // and `pg_notify`. Strip them once, here, so neither the DB write nor
            // the realtime publish below can choke. See stripNul.
            const output = stripNul(event.output);
            parts.push({ type: "tool-result", id: event.toolCallId, name: event.toolName, output });
            // The full output is in `parts` (saved to the DB at finish-step). Over
            // realtime we ship it only if it fits NOTIFY's budget; an oversized
            // body (e.g. a loaded skill) is dropped here so the small state-flip
            // event survives intact — the client backfills the body from the DB.
            const fits = Buffer.byteLength(JSON.stringify(output ?? null)) <= MAX_REALTIME_RESULT_BYTES;
            await publishTaskEvent(userId, {
              type: "task:tool-result", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, result: fits ? output : undefined, seq: ++seq,
            });
            await saveSnapshot(true); // keep the snapshot current with each step
            break;
          }
          case "tool-error":
            watchdog.exitTool(); // tool failed — back to waiting on the model
            await flushBuffers();
            // Strip NUL like every other string entering `parts`: a tool can throw
            // an error whose message embeds raw binary, which would otherwise break
            // the jsonb metadata write the same way a binary tool-result would.
            const toolErr = stripNul(errMsg(event.error));
            parts.push({ type: "tool-error", id: event.toolCallId, name: event.toolName, error: toolErr });
            await publishTaskEvent(userId, {
              type: "task:tool-result", taskId, chatId, messageId: msgId,
              toolCallId: event.toolCallId, result: { error: toolErr }, isError: true, seq: ++seq,
            });
            await saveSnapshot(true); // keep the snapshot current with each step
            break;
          case "error":
            streamError = errMsg(event.error);
            break;
          case "finish-step": {
            // Accumulate this step's usage live, so a later abort/cancel still
            // reports the tokens already billed (see liveUsage).
            const cached = event.usage.inputTokenDetails?.cacheReadTokens ?? 0;
            liveUsage.input += event.usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, (event.usage.inputTokens ?? 0) - cached);
            liveUsage.output += event.usage.outputTokens ?? 0;
            liveUsage.cached += cached;
            lastStepContextTokens = event.usage.inputTokens ?? 0;
            // Generic splits via the AI SDK's normalized usage (every provider):
            // cache WRITE is distinct from read, reasoning is a slice of output.
            liveUsage.cacheWrite += event.usage.inputTokenDetails?.cacheWriteTokens ?? 0;
            liveUsage.reasoning += event.usage.outputTokenDetails?.reasoningTokens ?? 0;
            // OpenRouter reports the REAL charge + the upstream that served this
            // step. `cost` is what OpenRouter billed; when it's 0 the request was
            // BYOK (you pay upstream directly), so fall to the upstream inference
            // cost. The SDK only types a subset of usage-accounting, so read loose.
            const or = (event.providerMetadata?.openrouter ?? undefined) as
              | { provider?: string; usage?: { cost?: number; costDetails?: { upstreamInferenceCost?: number } } }
              | undefined;
            if (or?.usage) {
              orLive.cost += or.usage.cost && or.usage.cost > 0
                ? or.usage.cost
                : or.usage.costDetails?.upstreamInferenceCost ?? 0;
              if (or.provider) orLive.upstreamProvider = or.provider;
            }
            // The OpenRouter generation id (`gen-…`) keys GET /api/v1/generation.
            if (typeof event.response?.id === "string" && event.response.id.startsWith("gen-")) {
              orLive.generationId = event.response.id;
            }
            // Flush buffered text, force a snapshot (streamSeq + parts) + renew
            // the lease per step. force=true bypasses the ~1s throttle so each
            // step boundary is durably persisted.
            await flushBuffers();
            await saveSnapshot(true);
            await heartbeat(taskId, workerId);
            break;
          }
        }
      }
      await flushBuffers();
      } catch (e) {
        // A stall aborts THIS attempt's signal. Depending on the SDK that ends the
        // stream via an "abort" event (caught by the break above) OR throws an
        // AbortError here — swallow the latter so the orchestration's `stalled`
        // path can re-stream. Anything else (a real error, or the task-wide `ac`
        // aborting on deadline/cancel) propagates as before.
        if (!(stalled && !ac.signal.aborted)) throw e;
      } finally {
        watchdog.stop();
      }
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
        await discardPartial();
        stripNativeFilesWithNote();
        // The provider rejected what the catalog claimed it took — fold those
        // modalities into the notice so the user is told to switch models.
        blindModalities = Array.from(new Set([...blindModalities, ...nativeModalities]));
        foldDiscarded();
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
        await discardPartial();
        foldDiscarded();
        result = makeStream();
        await consume();
        return true;
      }
      if (!reasoningStripped && isReasoningEchoRejectedError(err)) {
        // The backend behind this OpenAI-compatible endpoint (e.g. Cerebras via a
        // LiteLLM proxy) rejects the model's own `reasoning_content` when it's
        // echoed back — the openai-compatible SDK serializes prior reasoning parts
        // as that field unconditionally (vercel/ai#15042). We can't know the
        // backend up front, so flip reasoningStripped and re-stream. Two echo
        // sources, two folds: fold it into content on the historical modelMessages
        // here (covers a no-tool multi-turn chat, which has no tool loop /
        // prepareStep), AND — now that the flag is set — prepareStep folds it on
        // every intermediate tool-loop message going forward. Reasoning is kept as
        // content (Cerebras needs it back, just not as reasoning_content); the
        // DB/UI transcript keeps the original reasoning parts untouched.
        tlog.info("provider rejects reasoning_content echo — retrying with reasoning folded into content");
        reasoningStripped = true;
        streamError = undefined;
        await discardPartial();
        modelMessages = foldReasoningIntoText(modelMessages);
        foldDiscarded();
        result = makeStream();
        await consume();
        return true;
      }
      return false;
    };

    // Reactive context-overflow recovery. The proactive budget check compacts
    // BEFORE a turn, but a single huge first message (or a model whose window we
    // couldn't read) can still overrun. We can't summarize our way out — the
    // prefix is already too big to feed the model — so shrink MECHANICALLY: keep
    // only the most recent turns and re-stream. Once, so a still-too-big prompt
    // surfaces the friendly error instead of looping.
    let emergencyTrimmed = false;
    const retryOnContextOverflow = async (err: unknown): Promise<boolean> => {
      if (emergencyTrimmed || !isContextOverflowError(err)) return false;
      tlog.info("context overflow — emergency trim + retry", { keepRecent: EMERGENCY_KEEP_RECENT });
      emergencyTrimmed = true;
      streamError = undefined;
      await discardPartial();
      // Trim at the UI-message level — a tool call and its result live together
      // inside one assistant UIMessage there, so a mechanical slice can never
      // split the pair — then rebuild through the SAME safe pipeline the initial
      // build used (sealOrphanToolCalls + convertToModelMessages). Trimming the
      // already-split ModelMessage[] could strand a tool_result whose tool_use
      // was sliced off, which 400s as AI_MissingToolResultsError on the retry —
      // the very failure this path exists to recover from.
      const trimmedUi = trimToRecent(uiMessages, EMERGENCY_KEEP_RECENT);
      modelMessages = await convertToModelMessages(sealOrphanToolCalls(trimmedUi));
      markCacheTail(modelMessages); // fresh objects — re-mark the cache tail
      // Re-attach the turn's native files (the trim+reconvert produced fresh
      // model messages, dropping the bytes injected into the original set).
      if (injectedNative && nativeFiles.length) {
        await injectNativeFiles(modelMessages, sessionKey, userId, provider, nativeFiles);
      }
      foldDiscarded();
      result = makeStream();
      await consume();
      return true;
    };

    // Continuation: KEEP `parts`, rebuild the in-progress reply into a user-turn
    // "continue" request (never an assistant prefill — that 400s on modern
    // Anthropic), disable reasoning, arm the seam stitch, and re-stream. Returns
    // false when there's nothing to resume from (caller restarts clean instead).
    const resume = async (): Promise<boolean> => {
      await flushBuffers(); // canonical parts in DB + client before continuing
      const msgs = await buildResumeMessages(msgId, parts);
      if (msgs.length === 0) return false;
      resumeTail = getFullText().slice(-500);
      stitchNextDelta = true;
      useReasoning = false; // partial reasoning isn't replayable
      resumeMessages = msgs;
      result = makeStream();
      return true;
    };

    // One attempt = a stream consumed to completion, plus its capability/context
    // retries. A stall (watchdog abort, no throw) or a transient stream error is
    // recovered by CONTINUING from the partial — up to MAX_RECOVERIES — instead of
    // regenerating from scratch. Once exhausted, `stalledOut` surfaces the
    // friendly "provider didn't respond" failure while keeping the partial answer.
    for (;;) {
      stalled = false;
      let transient: unknown;
      try {
        await consume();
        // Provider surfaced the error as a stream event, not a throw.
        if (streamError && !ac.signal.aborted) {
          if (!(await retryOnCapabilityError(streamError)) && !(await retryOnContextOverflow(streamError))) {
            if (isTransientError(streamError)) transient = streamError;
          }
        }
      } catch (e) {
        if (!(await retryOnCapabilityError(e)) && !(await retryOnContextOverflow(e))) {
          if (isTransientError(e)) transient = e;
          else throw e;
        }
      }

      if (ac.signal.aborted) break;
      if (!stalled && transient === undefined) break;
      if (recoveries >= MAX_RECOVERIES) { stalledOut = true; break; }
      recoveries++;

      // Transient errors back off a beat; a stall retries at once (it already
      // burned the 60s idle window). On a successful resume the error must not
      // finalize as a failure.
      if (transient !== undefined) {
        streamError = undefined;
        await delay(1000);
        if (ac.signal.aborted) break;
      }
      tlog.info("provider recovery — re-streaming", { attempt: recoveries, max: MAX_RECOVERIES, kind: transient !== undefined ? "transient" : "stall" });

      // Replace the silent pause with a visible "model is slow, retrying". No seq —
      // a notice doesn't mutate the reply, so it must not consume a per-message slot.
      await publishTaskEvent(userId, {
        type: "task:notice", taskId, chatId, messageId: msgId,
        notice: { kind: "retrying", attempt: recoveries, max: MAX_RECOVERIES },
      });

      attemptAc = new AbortController(); // fresh signal; the stalled one stays aborted
      // Continue from the partial; if there's nothing to continue, restart clean.
      if (!(await resume())) { await discardPartial(); foldDiscarded(); result = makeStream(); }
    }

    // Retry once if the model produced no content. Skip after a stall-out — the
    // empty parts there mean "provider never spoke", not "model chose silence",
    // and another attempt would just stall again.
    if (!ac.signal.aborted && !streamError && !stalledOut) {
      const hasContent = parts.some((p) => (p.type === "text" && p.text.trim()) || p.type === "tool-call");
      if (!hasContent) {
        tlog.info("empty response — retrying once");
        await discardPartial();
        foldDiscarded();
        result = makeStream();
        try {
          await consume();
        } catch (retryErr) {
          streamError = errMsg(retryErr);
        }
      }
    }

    const finalStatus = deadlineHit ? "failed" : leaseLost ? "failed" : ac.signal.aborted ? "cancelled" : (stalledOut || streamError) ? "failed" : "completed";
    // Map any provider error to a friendly, role-aware shape: users see
    // `error`, admins can expand `errorDetail`. Raw text stays in tasks.error.
    // A stall-out gets its own category (distinct from a clean timeout) so the
    // user is told to retry/switch models rather than "shorten your request".
    const failure = deadlineHit ? TIMED_OUT_ERROR : leaseLost ? INTERRUPTED_ERROR : stalledOut ? PROVIDER_UNRESPONSIVE_ERROR : streamError ? classifyLLMError(streamError) : undefined;

    // Token usage + cost, computed once. Needed BOTH for the persisted message
    // metadata (so the (i) details survive a reload — elapsedMs and the usage
    // table are otherwise lost to the UI) and for the usage table below. Never
    // fatal: a failure here just omits the numbers from metadata. `inputTokens`
    // is the TOTAL input incl. cached reads, so split it — non-cached at the
    // input rate, cached reads at the discounted rate (avoids double-counting).
    // Usage from the live accumulator (robust to cancel/abort), not result.totalUsage.
    const usageMeta = liveUsage.input || liveUsage.output || liveUsage.cached
      ? {
          input: liveUsage.input, output: liveUsage.output, cached: liveUsage.cached,
          // Display-only splits — omitted when zero so old/simple turns stay clean.
          ...(liveUsage.cacheWrite > 0 ? { cacheWrite: liveUsage.cacheWrite } : {}),
          ...(liveUsage.reasoning > 0 ? { reasoning: liveUsage.reasoning } : {}),
        }
      : undefined;
    // Cost, resolved universally with a clear source of truth:
    //   • the provider's REAL charge wins whenever the provider reported one
    //     (OpenRouter served this turn — `orServed`). That figure is authoritative
    //     even when it's 0 (a `:free` model, or a flat-rate subscription gateway):
    //     a real 0 must NOT be overwritten by a catalog estimate.
    //   • otherwise fall back to the catalog price book (every other provider).
    // `costSource` is persisted so the UI can mark an estimate as approximate
    // rather than presenting it as the billed amount.
    const orServed = orLive.generationId != null || orLive.upstreamProvider != null;
    let costMeta: number | null = null;
    let costSource: "provider" | "catalog" | undefined;
    if (orServed) {
      costMeta = orLive.cost;
      costSource = "provider";
    } else if (usageMeta) {
      try {
        costMeta = await costUsd(modelId, {
          inputTokens: usageMeta.input, outputTokens: usageMeta.output, cachedInputTokens: usageMeta.cached,
        });
        if (costMeta != null) costSource = "catalog";
      } catch (e) {
        tlog.error("cost compute failed", { err: String(e) });
      }
    }

    // Context budget from the LAST step's actual prompt size (cached reads
    // included — the whole prefix occupies the window), NOT usageMeta's sum
    // across every step: a multi-step tool-calling turn re-reads the same
    // growing prefix from cache on each call, so summing would count that
    // prefix once per step and wildly overstate how full the window really is.
    // Computed once and reused: it drives both the long-chat aux path (memory
    // rides the hot prefix) and the compaction trigger below. "Long" = at least
    // half the effective window full.
    const budget = usageMeta
      ? contextBudget({ usedTokens: lastStepContextTokens, modelContextLength: contextLength, adminCap: adminCap || null })
      : undefined;
    const longChat = (budget?.fraction ?? 0) >= 0.5;

    // The reasoning/tool phase = start → first answer token (or the whole run if
    // it never produced answer text). Persisted so a reloaded transcript shows
    // the real "reasoned for …" time, not the full turn duration.
    const reasoningMs = (firstTextAt ?? Date.now()) - startedAt;

    await db.update(messages).set({
      content: getFullText(),
      metadata: {
        // A suspended turn is NOT done — mark it so the presenter maps the pending
        // tool call to its card state (approval-requested / ask input-available),
        // not an orphan error, and the client blocks the composer until the user
        // decides/answers.
        taskId, status: awaitingApproval ? "awaiting_approval" : awaitingAnswer ? "awaiting_answer" : finalStatus, parts: parts.length > 0 ? parts : undefined,
        ...(failure ? { error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category, errorOwned: ownKey } : {}),
        // Tech details for the (i) popover. A manual cancel still did real work
        // (it has a model, elapsed time, and billed tokens), so carry them too —
        // otherwise the stopped turn loses its (i) affordance. A failed turn owns
        // the ErrorNotice instead, so it stays excluded.
        ...(finalStatus === "completed" || finalStatus === "cancelled" ? {
          durationMs: Date.now() - startedAt,
          reasoningMs,
          model: modelId,
          ...(usageMeta ? { usage: usageMeta } : {}),
          ...(costMeta != null ? { costUsd: costMeta } : {}),
          ...(costSource ? { costSource } : {}),
          // The real upstream that served the turn (OpenRouter routes one model id
          // to many providers) — shown in the (i) popover's route section.
          ...(orLive.upstreamProvider ? { upstreamProvider: orLive.upstreamProvider } : {}),
          // OpenRouter generation id + the config it ran on: together they let the
          // (i) popover lazily fetch this turn's latency + provider chain from
          // GET /api/v1/generation, using the same key the turn was billed to.
          ...(orLive.generationId ? { generationId: orLive.generationId, configId } : {}),
          // Effective window (model ∩ admin cap) so the UI's context meter can
          // show how full the window is: contextTokens / this.
          ...(budget ? { contextWindow: budget.effectiveLimit, contextTokens: lastStepContextTokens } : {}),
        } : {}),
      },
    }).where(eq(messages.id, msgId));

    // Settle the turn's budget hold to the REAL figures BEFORE flipping the task
    // to its terminal status — so a completed task can never be left holding a
    // pending estimate (a crash between the two used to strand the hold until the
    // 30-day window; reconcileZombies' sweep is the backstop, this is the fix).
    // Reuses the split computed above; never throws on its own.
    if (usageMeta) {
      // Real-cost-aware fold of any retried-then-discarded attempts (billing
      // truth), even though the (i) popover above shows only the final one:
      //  • if the provider reported a real charge for a discarded attempt
      //    (discardedOrServed), add that authoritative cost to the final cost —
      //    don't lose it to a catalog recompute;
      //  • otherwise (catalog providers) let recordUsage recompute the cost from
      //    the combined token totals.
      const folded = discardedOrServed
        ? (costMeta ?? 0) + discarded.cost
        : hadDiscard
          ? undefined // recompute from combined tokens below
          : costMeta;
      await reconcileUsage({
        taskId, messageId: msgId, userId, provider, model: modelId, onSharedKey: isShared,
        usage: {
          inputTokens: usageMeta.input + discarded.input,
          outputTokens: usageMeta.output + discarded.output,
          cachedInputTokens: usageMeta.cached + discarded.cached,
        },
        costUsd: folded,
      });
    }

    await finalizeTask(taskId, finalStatus, failure?.adminDetail ?? streamError ?? null);
    if (payload.automationId) {
      // Outcome accounting must never fail the turn itself. A turn that SUSPENDED
      // for input (approval/ask) is neither a success nor a failure — report it as
      // "suspended" so the streak isn't reset (it didn't succeed) and isn't counted
      // as a failure; the overlap guard, keyed on the run's message state, blocks
      // the next occurrence until the user answers.
      const automationOutcome = awaitingApproval || awaitingAnswer ? "suspended" : finalStatus;
      const { recordAutomationOutcome } = await import("@/lib/automations/runs");
      await recordAutomationOutcome(payload.automationId, automationOutcome).catch((e) =>
        tlog.warn("automation outcome accounting failed", { err: String(e) }),
      );
    }
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
    // Build the Telegram approval payload (buttons + preview) only on an origin
    // channel — the web card fetches its own preview, so this query is skipped there.
    let telegramApproval: { messageId: string; title: string; before: string; after: string; impact?: string; body?: string; items?: string[] } | undefined;
    if (awaitingApproval && payload.origin) {
      const callPart = parts.find((p) => p.type === "tool-call" && p.id === awaitingApproval!.toolCallId);
      const input = callPart?.type === "tool-call" ? callPart.input : undefined;
      const { previewManageForUser } = await import("@/lib/manage/authed");
      // Pass the run's sandbox session so a workspace-path preview reads the real files.
      const pv = await previewManageForUser(userId, input, { sessionKey }).catch(() => null);
      if (pv) telegramApproval = { messageId: msgId, title: pv.title, before: pv.before, after: pv.after, impact: pv.impact, body: pv.body, items: pv.items };
    }
    // A suspended `ask` on an origin channel starts a sequential field-by-field
    // collection there (the web card fills the same role in the browser).
    const telegramAsk = awaitingAnswer && payload.origin
      ? { messageId: msgId, form: awaitingAnswer.form, userId }
      : undefined;
    await sink.finish({
      // The whole answer, persisted as one rich message (no bubble fragmentation).
      status: finalStatus, text: getFullText(), reasoning: getReasoning(),
      error: failure?.userMessage, errorDetail: failure?.adminDetail, errorCategory: failure?.category,
      isAdmin: failure ? await resolveIsAdmin() : false,
      toolCount, elapsedMs: Date.now() - startedAt, reasoningMs,
      ...(blindModalities.length ? { blindModalities } : {}),
      // Telegram gets Approve/Reject buttons + the same before→after preview the web
      // card fetches — computed here (only on an origin channel) from the suspended
      // call's input, so the tap resumes the turn instead of applying out-of-band.
      ...(telegramApproval ? { approval: telegramApproval } : {}),
      ...(telegramAsk ? { ask: telegramAsk } : {}),
    });
    // Deliver any files the agent created/edited this run to the origin channel
    // (Telegram). Best-effort and only on success — never fail the task over it.
    if (finalStatus === "completed" && !awaitingApproval && !awaitingAnswer && payload.origin) {
      try {
        const outFiles = await collectReferencedFiles(sessionKey, userId, getFullText());
        if (outFiles.length) await sink.sendFiles(outFiles);
      } catch (e) {
        tlog.warn("output file delivery failed", { err: String(e) });
      }
    }

    // Fold the turn into long-term memory (fire-and-forget). One reconcile call
    // maintains the doc for the current scope — the project doc in a project, else
    // the user-global doc; the agent's remember() tool covers the other scope on
    // demand. Gated on a clean completion (like the title): a cancelled/failed
    // turn shouldn't quietly spend tokens mining facts the user may have aborted.
    const lastUserText = (() => {
      const u = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
      if (!u) return "";
      if (typeof u.content === "string") return u.content;
      return u.content
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    })();
    if (finalStatus === "completed" && !awaitingApproval && !awaitingAnswer && lastUserText.trim()) {
      // trackAux: keep the worker's shutdown drain waiting on this fire-and-forget
      // call so a deploy doesn't kill it mid-flight (lost spend / dropped facts).
      void trackAux(maintainMemoryDoc({
        model,
        provider,
        userId,
        projectId: payload.projectId ?? null,
        scope: payload.projectId ? "project" : "user",
        turn: { userText: lastUserText, assistantText: getFullText() },
        onUsage: recordAuxUsage,
        // Long chat → ride the hot prefix for full-context, cache-priced
        // reconcile; short chat → undefined keeps the cheap standalone call.
        hotContext: longChat ? { systemMessages, modelMessages } : undefined,
      }).catch((e) => tlog.error("memory maintenance failed", { err: String(e) })));
    }

    // Auto-title the chat on its FIRST completed turn. "First turn" = no prior
    // assistant message in the history — a migration-free sentinel for "new chat"
    // that also never clobbers a title the user renamed by hand on a later turn.
    // The slice-of-first-message placeholder set by /api/chat stays visible until
    // this lands, so the sidebar always shows *something* in the meantime.
    const isFirstTurn = !modelMessages.some((m) => m.role === "assistant");
    if (finalStatus === "completed" && !awaitingApproval && !awaitingAnswer && isFirstTurn && lastUserText.trim()) {
      void trackAux(generateChatTitle(model, provider, lastUserText, getFullText(), recordAuxUsage)
        .then(async (title) => {
          if (!title) return;
          await db.update(chats).set({ title: stripNul(title) }).where(eq(chats.id, chatId));
          await publishTaskEvent(userId, { type: "chat:title", chatId, title });
        })
        .catch((e) => tlog.error("chat title generation failed", { err: String(e) })));
    }

    // Compaction. If this turn's INPUT neared the context-window budget, summarize
    // the conversation on the still-hot prefix and write a checkpoint, so the next
    // turn's buildModelContext collapses everything up to it into that summary.
    // Cache-friendly by construction (same system+history, instruction appended as
    // the final user turn — see buildCompactionMessages). Fire-and-forget like
    // title/memory; gated on a clean completion. `used` counts the FULL input
    // (cached reads included), since the whole prefix occupies the window.
    if (finalStatus === "completed" && !awaitingApproval && !awaitingAnswer && budget && budget.shouldCompact) {
      void trackAux(
        compactConversation(model, systemMessages, modelMessages, recordAuxUsage)
          .then(async (summary) => {
            if (!summary) return;
            // Re-entrancy floor: if the summary itself would still trip the
            // compaction threshold, checkpointing it is pointless — the next turn
            // would overflow again and we'd thrash compact→overflow→compact. Bail
            // and let the reactive emergency trim handle it. (~4 chars/token is a
            // deliberately rough estimate; we only need an order-of-magnitude.)
            const estSummaryTokens = Math.ceil(summary.length / 4);
            if (estSummaryTokens >= budget.effectiveLimit * COMPACT_THRESHOLD) {
              tlog.warn("compaction summary still over threshold — skipping checkpoint", {
                estSummaryTokens, effectiveLimit: budget.effectiveLimit,
              });
              return;
            }
            // Race guard: only checkpoint if the chat's leaf is STILL this reply.
            // A follow-up that already moved the leaf would otherwise get a
            // checkpoint grafted as its sibling — skip and let the next turn
            // re-evaluate the budget instead.
            const [row] = await db.select({ leaf: chats.activeLeafId }).from(chats).where(eq(chats.id, chatId)).limit(1);
            if (row?.leaf !== msgId) return;
            const checkpointId = nanoid();
            await db.insert(messages).values({
              id: checkpointId, chatId, parentId: msgId, role: "assistant", content: "",
              platform: payload.origin?.platform ?? "web",
              metadata: { status: "completed", compaction: { summary: stripNul(summary), summarizedUpTo: msgId, tokensSaved: budget.used } },
            });
            await db.update(chats).set({ activeLeafId: checkpointId }).where(eq(chats.id, chatId));
            // Tell the client so it reloads: the transcript gains the divider and
            // the context meter re-derives (hides until the next turn measures the
            // collapsed context). Without this the UI only catches up on a manual
            // reload — the compaction looked like nothing happened.
            await publishTaskEvent(userId, { type: "chat:compacted", chatId, messageId: checkpointId });
            tlog.info("conversation compacted", {
              usedTokens: budget.used, effectiveLimit: budget.effectiveLimit, checkpointId,
            });
          })
          .catch((e) => tlog.error("compaction failed", { err: String(e) })),
      );
    }
  } catch (e) {
    const isAbort = e instanceof Error && e.name === "AbortError";
    // A lost lease aborts by throwing — it must NOT read as a clean user cancel.
    const status = isAbort && !deadlineHit && !leaseLost ? "cancelled" : "failed";
    const failure = deadlineHit ? TIMED_OUT_ERROR : leaseLost ? INTERRUPTED_ERROR : isAbort ? undefined : classifyLLMError(e);
    // This catch swallows the error to finalize gracefully, so the worker's
    // crash log never fires — record it here instead. A clean cancel is info.
    tlog[status === "cancelled" ? "info" : "error"]("task ended", {
      status, elapsedMs: Date.now() - startedAt, toolCount,
      ...(failure ? { error: failure.adminDetail } : { err: String(e) }),
    });
    const failureMeta = {
      taskId, status, parts: parts.length > 0 ? parts : undefined,
      ...(failure ? { error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category, errorOwned: ownKey } : {}),
    };
    // If prepareRun threw before the assistant row existed (provider gone, model
    // removed), there's nothing to UPDATE — INSERT the failed reply instead and
    // point the chat at it, so the failure is a visible message rather than a
    // silent dead-end. Otherwise update the row we already streamed into.
    const persistMessage = messageInserted
      ? db.update(messages).set({ content: getFullText(), metadata: failureMeta }).where(eq(messages.id, msgId))
      : (async () => {
          const parentId = (payload.uiMessages ?? []).at(-1)?.id ?? null;
          await db.insert(messages).values({
            id: msgId,
            chatId,
            parentId,
            role: "assistant",
            content: getFullText(),
            platform: payload.origin?.platform ?? "web",
            metadata: failureMeta,
          });
          await db.update(chats).set({ activeLeafId: msgId }).where(eq(chats.id, chatId));
        })();
    await Promise.all([
      finalizeTask(taskId, status, failure?.adminDetail ?? null).catch(() => {}),
      persistMessage.catch(() => {}),
    ]);
    await publishTaskEvent(userId, { type: "task:finish", taskId, chatId, messageId: msgId, status, ...(failure ? { error: failure.userMessage } : {}) }).catch(() => {});
    await sink.finish({
      status, text: getFullText(), error: failure?.userMessage, errorDetail: failure?.adminDetail, errorCategory: failure?.category,
      isAdmin: failure ? await resolveIsAdmin() : false,
      toolCount, elapsedMs: Date.now() - startedAt,
    });

    // Bill the REAL spend already incurred before the abort/throw. A cancel,
    // deadline, lost lease, or thrown provider error can still leave tokens spent
    // on the shared key (live + any discarded-attempt tokens). The old path only
    // releaseHold'd here, silently discarding that real spend; reconcile it to the
    // hold instead so the shared key is billed. When NOTHING was spent (or
    // prepareRun threw before resolving the run), there's no usage to bill — the
    // finally's releaseHold then correctly cancels the untouched hold.
    const spentInput = liveUsage.input + discarded.input;
    const spentOutput = liveUsage.output + discarded.output;
    const spentCached = liveUsage.cached + discarded.cached;
    if (runModelId && (spentInput || spentOutput || spentCached)) {
      // Prefer the provider's authoritative real charge whenever one was reported
      // (this attempt's orLive, plus any discarded attempts'); else let
      // reconcileUsage recompute from the catalog over the combined tokens.
      const orServed = orLive.generationId != null || orLive.upstreamProvider != null;
      const realCost = orServed || discardedOrServed ? orLive.cost + discarded.cost : undefined;
      await reconcileUsage({
        taskId, messageId: msgId, userId, provider: runProvider ?? "shared", model: runModelId, onSharedKey: runShared,
        usage: { inputTokens: spentInput, outputTokens: spentOutput, cachedInputTokens: spentCached },
        costUsd: realCost,
      }).catch(() => {});
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(monitor);
    // Self-heal the budget hold: a turn that produced real spend (completed, or a
    // failed/cancelled turn that still billed tokens) already reconciled the hold
    // to its real cost above, so this deletes nothing; a turn that spent NOTHING
    // leaves the estimate pending — release it here so it never inflates the
    // budget. A hard process crash skips this; reconcileZombies sweeps those.
    await releaseHold(taskId).catch(() => {});
    await closeMcp?.().catch(() => {});
  }
}
