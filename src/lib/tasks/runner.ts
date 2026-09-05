import { streamText, convertToModelMessages, stepCountIs } from "ai";
import type { ModelMessage, UserModelMessage } from "ai";
import { and, asc, eq } from "drizzle-orm";
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
import { heartbeat, isCancelRequested, finalizeTask, commitTurnOutcome, absorbQueuedTasks, trackAux } from "@/lib/tasks/queue";
import { buildRecoveryNote, effectsFromParts, mergeEffects, recordEffect, loadEffects, loadInheritedEffects, withEffectLedger, EffectLedgerError, type TurnEffect } from "@/lib/tasks/effect-ledger";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { telemetryFor, setTurnOutcome, type TurnStatus } from "@/lib/telemetry";
import { listFiles } from "@/lib/sandbox/client";
import { extractWorkspacePaths, selectTouchedFiles, type ToolWindow } from "@/lib/chat/artifacts";
import { classifyFiles, findBlindModalities } from "@/lib/chat/prompt";
import { mimeToModality, type Modality } from "@/lib/providers/registry";
import { buildViewFileInjection } from "@/lib/sandbox/view-file";
import { askFormSchema, type AskForm } from "@/lib/ask/types";
import { buildModelContext, trimToRecent, type ContextRow } from "@/lib/chat/context/build";
import { contextBudget, COMPACT_THRESHOLD } from "@/lib/chat/context/budget";
import { contextManagementOptions, mergeProviderOptions, shouldClearToolResults, thinkingIsDeep, markStepTail,
  clearsToolResultsClientSide, toolClearTrigger, TOOL_CLEAR_KEEP_LAST } from "@/lib/chat/context/provider-edits";
import { stepSettings, foldReasoningIntoText, pruneTurnToolTraffic, armPruneBoundary, estimatePromptTokens,
  MAX_STEPS } from "@/lib/chat/context/step-control";
import { compactConversation } from "@/lib/chat/context/compactor";
import { recordAuxSpend } from "@/lib/tasks/aux-spend";
import { resolveAuxTarget } from "@/lib/providers/resolve";
import { auxGenerate } from "@/lib/chat/context/aux";
import { reconcileUsage } from "@/lib/usage";
import { releaseHold } from "@/lib/billing/limits";
import { costUsd, toTokenUsage, type TokenUsage } from "@/lib/pricing";
import { extractFacts } from "@/lib/vault/extract";
import { generateChatTitle } from "@/lib/chat/title";
import { classifyLLMError, isModalityUnsupportedError, isReasoningUnsupportedError, isReasoningEchoRejectedError, isStreamUsageRejectedError, parseAllowedEfforts, isContextOverflowError, parseContextWindow, isTransientError, timedOutError, providerUnresponsiveError, interruptedError, RESPONSE_TRUNCATED_ERROR } from "@/lib/errors/friendly";
import { disableStreamUsage } from "@/lib/providers/stream-usage";
import { availableAmounts, clampAmount, reasoningParams } from "@/lib/models/thinking";
import { rememberModelCannotReason, rememberModelContextLength, rememberModelEfforts } from "@/lib/models/catalog";
import { buildResumeMessages, stitchOverlap } from "./resume";
import { StallWatchdog } from "./stall-watchdog";
import { repairToolCall } from "./tool-repair";
import { errorText } from "@/lib/errors/message";
import { type FileRef } from "@/lib/constants";
import type { StoredPart, MessageMeta, AuxRecord } from "@/lib/chat/contracts";
import { sourcesFromOutput, type NumberedSource } from "@/lib/mcp/search-normalize";
import { citedSources } from "@/lib/chat/citations";
import { log } from "@/lib/log";
import { injectNativeFiles, collectReferencedFiles } from "./run-attachments";
import { foldAssembledRows, untrustedOutputOf } from "./turn-taint";
import { prepareRun } from "./run-context";
import { foldTurnHalves, type TurnHalf } from "./turn-accounting";
import { MAX_TURN_TOOL_OUTPUT_CHARS, outputChars } from "@/lib/tool-output";
import { nonNegInt, posInt } from "@/lib/config/env";

const errMsg = (e: unknown) => errorText(e);

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
 *
 * Operator knob: the default covers ordinary turns, but it bounds the WHOLE turn
 * including every tool call, so heavy sandbox work (a batch document conversion, a
 * long Playwright scrape, video transcoding) can legitimately need more. Raise
 * TASK_TIMEOUT_MINUTES rather than letting such turns fail as timeouts.
 *
 * 20 minutes, not the 10 this started at, because 10 was smaller than the OTHER
 * ceiling on the same turn: MAX_STEPS tool calls at the controller's per-exec
 * timeout is 12.5 minutes of sandbox time alone, before a token of model latency.
 * A turn doing legitimate heavy work therefore hit the clock with step budget still
 * unspent — the clock was capping work, not catching runaways. It is also no longer
 * the hang detector it once was: STREAM_IDLE_MS catches a silent provider inside a
 * minute, leaving this deadline to do the one job it is good at — bounding a slow
 * but LIVE run so it can't hold a worker slot forever.
 */
const MAX_TASK_MS = posInt(process.env.TASK_TIMEOUT_MINUTES, 20) * 60_000;

/**
 * Stream stall ceiling. A provider can accept the request and then go silent —
 * no tokens, not even reasoning — which, with only MAX_TASK_MS as a backstop,
 * left the user staring at a blank chat for 10 minutes before a generic timeout.
 * The stall watchdog aborts an attempt that produces nothing for this long while
 * we're waiting on the model (it's PAUSED during local tool execution, which is
 * legitimately quiet — see StallWatchdog). 60s is comfortably longer than any
 * real time-to-first-token, short enough that a hung gateway fails fast. This is
 * the FIRST attempt's window; every retry gets twice it (see `consume`), so the
 * knob scales the whole progression.
 */
const STREAM_IDLE_MS = posInt(process.env.STREAM_IDLE_SECONDS, 60) * 1000;
/** Max recovery attempts (stall + transient) per turn before giving up with a
 *  clear "provider didn't respond" message. A transient gateway hiccup usually
 *  clears on the first retry; past 3 the model/provider is genuinely unhealthy. */
const MAX_RECOVERIES = nonNegInt(process.env.MAX_STREAM_RECOVERIES, 3);

/** Reactive context-overflow fallback: how many of the most recent conversation
 *  messages to keep when mechanically trimming a prompt the model rejected as too
 *  long. Generous enough to preserve the live exchange, small enough to fit. */
const EMERGENCY_KEEP_RECENT = 10;

/** How far the end-of-turn scan looks for files the turn changed but the reply
 *  never named. Three levels covers the way agents actually organise output (a
 *  folder or two deep) without walking a checked-out repo or a node_modules an
 *  agent installed; the cap then bounds the response for a workspace that is a
 *  build tree regardless. Both are ceilings on ONE listing per finished turn. */
const WORKSPACE_SCAN_DEPTH = 3;
const WORKSPACE_SCAN_LIMIT = 2000;

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
  // Why the model stopped, per the provider. Only "length" is acted on (see
  // RESPONSE_TRUNCATED_ERROR); the rest are normal endings or already covered by
  // their own signals.
  let lastFinishReason: string | undefined;
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
  // When the abort above will fire. Read per step so the turn can brake into a text
  // answer before the deadline cuts it mid-tool (see stepSettings / WRAP_UP_AFTER_FRACTION).
  const deadlineAt = Date.now() + MAX_TASK_MS;
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
  // Every tool call this turn has actually EXECUTED. Deliberately separate from
  // `parts` because the two have opposite lifetimes: `parts` is the reply being
  // built and is thrown away by a retry, while an executed call stays executed.
  // Read only by the emergency-overflow path, which restarts the turn from settled
  // history and needs to tell the model what it already did. See effect-ledger.
  const turnEffects: TurnEffect[] = [];
  /**
   * Executed calls belonging to the PREVIOUS reply (or replies) this turn continues,
   * when that reply failed part-way. Deliberately NOT `turnEffects`: this array is
   * context — what the model must not repeat — while `turnEffects` is this reply's
   * accounting, deciding its failure verdict and owning the rows written under its own
   * message id. Folding them would make a fresh turn report partial work before it had
   * done anything, and would attribute another reply's calls to this one.
   */
  const inheritedEffects: TurnEffect[] = [];
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
  // parts to one string (Telegram) would otherwise glue "…the limit.Admin rights…" into
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
  let runConfigId: string | undefined;
  let runShared = false;
  const liveUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
  // What an approval continuation's FIRST half already billed. A continuation reuses
  // the suspended message's row, so this run is the second half of one logical turn
  // and the (i) popover has to show both — read off that row below, folded in at the
  // metadata write only (foldTurnHalves explains why the ledger must not see it).
  const prior: TurnHalf = {};
  // The LAST step's raw prompt size (input incl. cached), overwritten (not summed)
  // on every finish-step — unlike liveUsage above, this is a snapshot of the final
  // call's context, not a running total across a multi-step tool-calling turn.
  let lastStepContextTokens = 0;
  // How many LLM round-trips this turn took. "Why did this burn 12 steps" is one
  // of the two questions asked of a slow turn (the other is retries/stalls), and
  // neither was answerable from the trace before.
  let stepCount = 0;
  const discarded = { input: 0, output: 0, cached: 0, cacheWrite: 0, cost: 0 };
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
  const sink = makeDeliverySink(payload.origin, taskId);
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
  // When each tool call ran, so the finalize path can tell which workspace files
  // THIS turn touched. Chats in a project share one folder, so "changed since the
  // turn began" would credit us with a parallel chat's output; only the moments we
  // were actually executing a tool can belong to us. Open calls live in the map,
  // completed ones move to the list — a call still open at finish (cancel, crash)
  // simply contributes no window, which errs toward showing less.
  const toolStartedAt = new Map<string, number>();
  // Calls the SDK rejected before running them (unparseable arguments, unknown
  // tool). It synthesizes a `tool-error` for these WITHOUT invoking execute, so that
  // error is not evidence anything happened — and ledgering it would tell a
  // restarted turn "this already ran, do not repeat" about work that never ran.
  // That is an omission, which is worse than the duplication the ledger prevents.
  const invalidCalls = new Set<string>();
  // Characters of tool output this turn has produced, summed across every call.
  // MAX_TOOL_OUTPUT_CHARS bounds ONE result; nothing bounded the sum, so a turn
  // making a hundred calls had no ceiling at all. Enforced by stopping (see the
  // toolChoice override in prepareStep), never by rewriting a result.
  let turnOutputChars = 0;
  let toolWindows: ToolWindow[] = [];
  const closeToolWindow = (toolCallId: string) => {
    const start = toolStartedAt.get(toolCallId);
    if (start === undefined) return;
    toolStartedAt.delete(toolCallId);
    toolWindows.push({ start, end: Date.now() });
  };

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
      // Nothing was streamed yet, so there is no message to write — but the event
      // still announces an outcome, and announcing one we don't own would contradict
      // whatever the reconciler already told this user.
      if (await finalizeTask(taskId, "cancelled", null, workerId)) {
        await publishTaskEvent(userId, { type: "task:finish", taskId, chatId, status: "cancelled" });
      } else {
        tlog.warn("cancellation outcome was already settled elsewhere; standing down");
      }
      return;
    }

    // `prepareRun` resolves the model and connects every tool source before the
    // first token can exist — seconds of it on a chat with remote connectors, and
    // it runs BEFORE task:start, so the client had nothing to show and no clock
    // running for the whole stretch. Name it. Not awaited on the critical path:
    // a realtime hiccup must not delay the run it is only narrating.
    void publishTaskEvent(userId, {
      type: "task:notice", taskId, chatId, messageId: msgId, notice: { kind: "phase", phase: "preparing" },
    }).catch(() => {});
    const { model, provider, modelId, modelInput, isShared, configId, tools: rawTools, viewFileBridge, closeMcp: close, prompt, contextLength, adminCap, toolSearch, profile, thinkAmount, modelEfforts, modelCannotReason, sourceCounter, userSpaceId, projectSpaceId, userTurnText, taint } =
      await prepareRun(userId, sessionKey, payload, chatId, msgId, taskId);
    // `taint` — has this turn read anything it did not author? — is CONSTRUCTED in
    // prepareRun and arrives here, rather than being built here from a seed: the vault's
    // tool factory needs the same object, it runs inside prepareRun, and a turn with two
    // taints would lose half its marks. Keyed by the MESSAGE, not this task: an
    // approval/`ask` continuation is a second task writing this same row, and none of the
    // construction sites re-runs for its rehydrated input — so the first half's answer is
    // seeded from the row rather than recomputed. See turn-taint.ts.
    // Every locally-executed tool goes behind the write-ahead boundary, keyed by the
    // reply this turn is writing. Wrapped HERE and not in prepareRun because `msgId` is
    // what the row belongs to and this is the scope that owns it — and because a tool
    // set that reached streamText unwrapped would leave the whole dispatch-time half of
    // the ledger as dead code. `withEffectLedger` returns a tool without an `execute`
    // untouched, which is what keeps `ask` a suspend and provider-executed tools remote.
    const tools = withEffectLedger(rawTools, { messageId: msgId, taskId });
    closeMcp = close;
    ownKey = !isShared; // own-key failures are the user's to see + fix
    // Publish the run identity to the outer scope so the catch path can reconcile
    // real spend (H6) on an abort/throw mid-stream.
    runProvider = provider;
    runModelId = modelId;
    runConfigId = configId;
    runShared = isShared;



    // Record a background LLM call's spend against the same key and budget as the
    // main turn, AND name what it bought — on the ledger row and on the message the
    // user is looking at. These fire-and-forget calls used to go entirely unbilled
    // (cost analytics under-reported every turn); now they are also the answer to
    // "why did one message make three requests", which nothing could give before.
    //
    // A factory rather than one callback: the three passes are dispatched together
    // and each has to label its own row, so the purpose is bound at the call site
    // that knows it rather than inferred downstream.
    // Kept per purpose so a caller can WAIT for its own accounting before telling
    // the client to re-read the row (the title pass does; see below). A bare `void`
    // was the first shape here and it was wrong twice over: the write is not covered
    // by `trackAux`, so a shutdown drain reads zero in-flight work and can kill it
    // mid-insert, and nothing downstream can tell whether the row is written yet.
    const auxWrites = new Map<AuxRecord["purpose"], Promise<void>>();
    const auxUsageRecorder = (
      purpose: AuxRecord["purpose"],
      on: { provider: string; modelId: string; configId: string; isShared: boolean } =
        { provider, modelId, configId, isShared },
    ) =>
      (u: TokenUsage) => {
        auxWrites.set(purpose, trackAux(recordAuxSpend({
          taskId, messageId: msgId, userId,
          provider: on.provider, configId: on.configId, model: on.modelId,
          turnModel: modelId, onSharedKey: on.isShared, purpose, usage: u,
        })));
      };

    // Where the title and memory passes run. Resolved ONCE and lazily: most installs
    // leave it unset, and a turn that spawns no background work should not pay a
    // settings read plus a provider resolve to discover that. Compaction is absent
    // by design — it rides the turn's own cached prefix, and moving it elsewhere
    // pays full price for the whole conversation (see getAuxModelRef).
    let auxTargetMemo: Promise<Awaited<ReturnType<typeof resolveAuxTarget>>> | undefined;
    const auxTarget = () =>
      (auxTargetMemo ??= resolveAuxTarget(userId, { model, provider, modelId, configId, isShared }));

    // Prompt caching, three tiers of system messages (see buildSystemPrompt):
    //  1. stable  — persona+sandbox+project+skills, identical for everyone →
    //     first ephemeral breakpoint, reused across all users/chats.
    //  2. session — name + conversation-start date, constant for this chat →
    //     its own breakpoint, reused on every turn of the conversation.
    //  3. volatile — memories/workspace/files, per-run, sent uncached last so
    //     churn never invalidates the cached prefixes.
    // `providerOptions.anthropic` is namespaced — non-Anthropic providers ignore it.
    const ephemeral = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;
    // Every tier is conditional, INCLUDING stable: a project in raw-prompt mode with
    // no instructions of its own legitimately produces nothing here, and shipping
    // `content: ""` would have Anthropic reject the whole request for an empty text
    // block. No stable tier simply means no breakpoint — there is nothing to cache.
    const systemMessages: ModelMessage[] = [];
    if (prompt.stable) {
      systemMessages.push({ role: "system", content: prompt.stable, providerOptions: ephemeral });
    }
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
      // Rebuild the effect ledger from the row, not from this process's memory: the
      // first half of this turn ran in a DIFFERENT task (and possibly a different
      // process), so its executed tool calls exist only here. Without this, a
      // continuation that later overflows would report an empty ledger and re-run
      // the first half's writes — the exact failure the ledger exists to prevent.
      // Both sources, unioned by tool-call id with the ledger winning — not one or
      // the other. An emergency trim clears `parts`, so the ledger is the stronger
      // record; but during a rolling upgrade the half that ran before the table
      // existed lives ONLY in `parts`, and an empty ledger is also what a failed
      // write leaves behind. Choosing a source would drop the other's entries, and a
      // dropped effect is precisely the one that gets done twice. See mergeEffects.
      turnEffects.push(...mergeEffects(await loadEffects(resumeMessageId), effectsFromParts(meta.parts ?? [])));
      seq = meta.streamSeq ?? 0;
      // (The citation counter is seeded branch-wide at the path load below —
      // the path ends at this very message, so the suspended half's numbers
      // are covered there.)
      // The suspended half's accounting, carried so the finalize below reports the
      // WHOLE turn. A suspended turn finalizes as `completed` (only its metadata
      // `status` says awaiting_*), so these were persisted; the first snapshot of
      // this run overwrites the row's metadata, which is why they're read here and
      // held in memory rather than merged at write time.
      prior.usage = meta.usage;
      prior.costUsd = meta.costUsd;
      prior.costSource = meta.costSource;
      prior.durationMs = meta.durationMs;
      prior.reasoningMs = meta.reasoningMs;
      prior.llmCalls = meta.llmCalls;
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
      // "Continue" after a part-way failure arrives here, not on the resume path: it
      // sends an ordinary user message, so this reply is a NEW row and the ledger it
      // must not re-run belongs to the reply above it. Detected from that reply's own
      // recorded verdict rather than a flag the client sends, so it also covers the
      // user who types their own follow-up instead of pressing the button.
      if (replyParentId) inheritedEffects.push(...await loadInheritedEffects(replyParentId));
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
    // The model's real context ceiling (model window, narrowed by any admin cap).
    // Computed once here because two things downstream need it: the provider's own
    // context-management trigger below, and the tool-clearing threshold just under.
    const effectiveLimit = contextBudget({ usedTokens: 0, modelContextLength: contextLength, adminCap: adminCap || null }).effectiveLimit;
    let uiMessages = payload.uiMessages ?? [];
    // Whether this turn's context was built with tool bodies cleared — persisted
    // on the message below, because the decision for the NEXT turn depends on it
    // (see shouldClearToolResults).
    let toolsCleared = false;
    // The provider-blind half of the same decision: whether the conversation has
    // grown deep enough that shedding beats keeping. `toolsCleared` records what WE
    // did about it, which is always false on a provider that sheds server-side — so
    // the server-side edits need this one instead. Persisted for the same reason:
    // shedding shrinks the next measurement, so the answer has to be sticky.
    let contextDeep = false;
    // Every numbered source the branch has already minted (prior turns' search
    // results). Two consumers: the counter seed just below — numbers must be
    // unique across the BRANCH, not the message, because the model reads the
    // whole history and a re-minted [1] would attach an old claim to an
    // unrelated new source — and the finalize step, which resolves this turn's
    // [N] markers against branch + own sources (a follow-up may legitimately
    // cite a source the previous turn's search produced).
    const branchSources: NumberedSource[] = [];
    if (replyParentId) {
      const path = await loadActivePath(chatId, replyParentId);
      // Shape the path into the model's view: collapse history at the newest
      // compaction checkpoint into its summary (cache-stable — the checkpoint
      // doesn't move, so the prefix stays a cache hit between turns). The DB and
      // the UI transcript keep the full history; only the model's view is trimmed.
      // …and, on providers WITHOUT server-side tool-result clearing, shed the
      // bodies of tool results the agent already acted on. Anthropic does this
      // itself (ctxMgmt below), cache-coherently; everywhere else those bodies —
      // a whole file read, a loaded skill — were replayed in full on every turn
      // until compaction finally fired, because this option was never passed and
      // the clearing code was unreachable. Same shared policy on both paths.
      //
      // Gated on the conversation actually being deep: below the threshold the
      // prefix stays byte-stable and the prompt cache keeps hitting, which is
      // worth more than the tokens. The signal is the prompt size the previous
      // turn already measured and persisted — nothing new to compute or store.
      const nodes = path.map((p) => p.node);
      // Collect from the FULL path, not the compaction-collapsed model view:
      // the transcript still renders every old message, so uniqueness has to
      // hold against everything the user can see.
      for (const n of nodes) {
        for (const p of ((n.metadata as MessageMeta | null)?.parts ?? [])) {
          if (p.type === "tool-result") {
            const s = sourcesFromOutput(p.output);
            if (s) branchSources.push(...s);
          }
        }
      }
      const maxSource = Math.max(0, ...branchSources.map((s) => s.n));
      if (maxSource > 0) sourceCounter.next = maxSource + 1;
      contextDeep = thinkingIsDeep(nodes, effectiveLimit);
      toolsCleared = shouldClearToolResults(provider, nodes, effectiveLimit);
      if (path.length) {
        const assembled = buildModelContext(nodes as ContextRow[],
          toolsCleared ? { clearToolsKeepLast: TOOL_CLEAR_KEEP_LAST } : {});
        uiMessages = toUIMessages(assembled);
        // THE FOLD, over the ENTIRE assembled prompt — every row the model can see right
        // now, replayed history included. Not "what this turn newly constructed": poison
        // that arrives in turn 1 and acts in turn 5 is still verbatim in the prompt the
        // model is reading as it writes, and a per-turn fold would call turn 5 clean,
        // displacing the durable bound by exactly one turn.
        //
        // It reads the mark STORED AGAINST each row and nothing else — never `role`,
        // never `type`, never any text the row contains. `applyCompaction` splices a
        // summary as `role: "user"`, which is exactly the shape a naive fold would read as
        // `user_authored`; that row's own column is what this reads instead.
        //
        // A turn with no parent path folds `false` by construction — there is no history
        // to be tainted by — and that is correct rather than a hole: the first turn of a
        // chat can only be tainted by its own construction sites, which run below.
        if (foldAssembledRows(assembled)) await taint.mark("replayed_row");
      }
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
    // Breakpoint budget (Anthropic max 4): stable + session + this + the moving
    // step tail in prepareStep = 4 — don't add a fifth.
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
      // `replyParentId ?? msgId`: on a fresh turn that is the USER message the attachment
      // rides — the row that survives a regenerate — and on a continuation it is
      // `resumeMessageId`, which is `msgId` and therefore this taint's own target.
      injectedFiles = await injectNativeFiles(modelMessages, sessionKey, userId, provider, nativeFiles, replyParentId ?? msgId);
      injectedNative = injectedFiles.length > 0;
      // The row above carries the mark durably; this carries it into THIS turn's own gate,
      // which the fold above ran too early to see (the attachment is injected after it).
      if (injectedNative) await taint.mark("native_attachment");
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
        // Without the sandbox group there are no file tools, so the usual "open it
        // with a tool" line would be an instruction the model cannot follow — it
        // would either apologize cryptically or invent the contents. Tell it the
        // truth instead and let it say so plainly, in the user's own language.
        // (Native attachments still arrive normally: handing the model bytes isn't
        // a tool call, so images and PDFs work in a tool-less project.)
        block += profile.capabilities.sandbox
          ? `\nOpen the files without that note using tools as needed (e.g. view_file for images and PDFs).`
          : `\nYou have NO file tools in this chat, so you cannot open the files without that note at all. Say so plainly — this project is set up without file access — instead of guessing at their contents.`;
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

    // How hard to think, as the user set it for this chat, translated to this
    // provider's wire format (an effort enum or a token budget — see
    // models/thinking.ts). `modelEfforts` is the enum this model has previously
    // told us it accepts; null until the negotiation below learns it.
    //
    // Applied optimistically ONLY while the model has not already refused: a model
    // that only accepts OTHER effort values teaches us its enum on the way
    // (retryOnCapabilityError), but one that rejects reasoning outright told us so
    // once and `modelCannotReason` remembers it — otherwise every turn paid that
    // rejection plus a full stream restart, forever.
    let reasoning = modelCannotReason ? undefined : reasoningParams(provider, thinkAmount, modelEfforts);
    let useReasoning = reasoning !== undefined;
    // Effective window (model ∩ admin cap) drives the provider-native edit's
    // trigger. Reused from the budget logic so the cap is honored here too.
    const ctxMgmt = contextManagementOptions(provider, effectiveLimit, contextDeep);
    // Intra-turn relief for providers with no server-side edit of their own. Same
    // trigger as the other two enforcement sites, measured off the live per-step
    // prompt size, and re-applied on every step once armed (see pruneTurnToolTraffic).
    const intraTurnPruneAt = clearsToolResultsClientSide(provider) ? toolClearTrigger(effectiveLimit) : 0;
    // Absolute index of the cut, 0 until the turn outgrows the trigger. Re-applied
    // every step and only ever moving forward — a `messages` value returned from
    // prepareStep is that step's prompt and nothing else (the SDK rebuilds from its
    // own `initialMessages` each step), so a one-shot prune would relieve exactly
    // one call and re-shape the prompt twice to do it. Lifetime is ONE STREAM, not
    // one turn: makeStream resets it, for the reason spelled out there.
    let pruneBoundary = 0;
    // Deliberately NOT reset by makeStream, unlike pruneBoundary. The boundary is an
    // index into one stream's list and dies with it; "this turn's tool traffic already
    // crossed the trigger" is a fact about the TURN and stays true across a re-stream.
    // Keeping them in one variable is what made a restart wait a step to re-earn relief
    // it had already earned.
    let pruneArmedEarlier = false;
    // Stall detection runs per-attempt: `ac` is the task-wide signal (deadline,
    // cancel, lost lease); `attemptAc` aborts only the CURRENT stream when the
    // provider goes silent, so a retry can re-stream without the whole task
    // reading as cancelled. The model's signal is the union of both. A stalled
    // attempt sets `stalled` and is recovered up to MAX_RECOVERIES; once
    // exhausted, `stalledOut` makes finalization surface PROVIDER_UNRESPONSIVE.
    let attemptAc = new AbortController();
    let stalled = false;
    let stalledOut = false;
    // `stalled` is per-attempt and resets on each retry; `stalledOut` means we gave
    // up. Neither answers "did this turn wait on a silent provider at any point",
    // which is the interesting one for a turn that recovered and still took 90s.
    let stalledEver = false;
    let recoveries = 0;
    // A continuation re-stream appends these to the prompt (see resume()); empty
    // on the first attempt and on clean (capability/context) restarts.
    let resumeMessages: ModelMessage[] = [];
    // One-shot seam fix applied to the first text delta after a resume.
    let stitchNextDelta = false;
    let resumeTail = "";
    const watchdog = new StallWatchdog(STREAM_IDLE_MS, () => {
      stalled = true;
      stalledEver = true;
      tlog.warn("provider.stall", { model: modelId, attempt: recoveries, idleMs: STREAM_IDLE_MS });
      attemptAc.abort();
    });

    // Set once a backend 400s on echoed `reasoning_content` (see
    // retryOnCapabilityError). Hoisted above makeStream because prepareStep reads
    // it on the very first step — declaring it later would TDZ-throw.
    let reasoningStripped = false;
    // One effort re-map per turn: the model's own enum is authoritative, so if a
    // value taken FROM it is rejected too, stop negotiating and fall through to
    // the plain drop-reasoning path instead of ping-ponging.
    let effortNegotiated = false;
    const makeStream = () => {
      // A NEW stream voids the mid-turn cut: `pruneBoundary` indexes the list the
      // SDK rebuilds from its own `responseMessages`, and a fresh streamText throws
      // those away. Every caller here is a re-stream (capability retry, overflow
      // trim, stall resume), so invalidating it belongs to the thing that creates
      // the stream — an eleventh retry path added later cannot forget to.
      //
      // A resume does NOT merely append, which is the trap: `StoredPart` carries no
      // `step-start`, so convertToModelMessages groups a whole tool loop into ONE
      // assistant + ONE tool message and buildResumeMessages returns exactly three
      // messages for any loop length (measured: 1/4/12/30 exchanges → 3, 3, 3, 3).
      // Any boundary armed past 3 therefore outruns the rebuilt list, `keepLast`
      // goes <= 0, and the brake disengages for the rest of the turn.
      //
      // Cheap, not free: those three messages still carry the whole loop's TOKENS
      // (only the count collapsed — 30 exchanges measured 12.9k chars), so the next
      // measurement is still over the trigger and the cut re-arms at step 1. One
      // unbraked step and one cache transition, not a lost turn. What the collapse
      // does cost is granularity: N calls in ONE message means the pruner, which
      // works per message, sheds the resumed loop's traffic all at once or not at
      // all. Inherent to the missing `step-start`, not to the cut. And that is why
      // `lastStepContextTokens` is deliberately NOT reset alongside it: it is the
      // (i) popover's and the context meter's figure too, so zeroing it would report
      // an empty window on a turn that died of a full one. armPruneBoundary's
      // `stepNumber === 0` guard is what keeps it from arming off that ghost.
      pruneBoundary = 0;
      // reasoning + context-management + caching may all target the same provider
      // namespace (e.g. anthropic) — merge so none clobbers the others.
      const providerOptions = mergeProviderOptions(
        useReasoning ? (reasoning as Record<string, Record<string, unknown>>) : undefined,
        ctxMgmt as Record<string, Record<string, unknown>> | undefined,
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
              stopWhen: stepCountIs(MAX_STEPS),
              // Salvage the one malformation that is a formatting slip rather than a wrong
              // request: several tool calls emitted as one set of arguments. Anything else
              // (and any unknown tool) is left to fail, so the model sees its own mistake.
              experimental_repairToolCall: repairToolCall as never,
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
                // RELIEF: shed the tool traffic this turn accumulated before the cut,
                // armed the first step whose measured prompt crossed the trigger and
                // re-applied at the same absolute index every step after. Everything
                // else in the context machinery works at a turn boundary, so without
                // this a single long tool loop has no brake at all on any provider
                // Anthropic doesn't serve directly. Deliberately before the cache
                // marker below, so the marker lands on the pruned tail.
                if (intraTurnPruneAt) {
                  const next = armPruneBoundary({
                    triggerAt: intraTurnPruneAt, boundary: pruneBoundary,
                    // `base`, not `msgs`: the boundary is an ABSOLUTE index into the
                    // list the SDK rebuilds each step, and the bridge appended above
                    // belongs to ONE step. Measuring the injected list armed the cut
                    // one message deeper than intended for the rest of the stream.
                    // Pruning still runs on `msgs` — that difference is what keeps the
                    // injection itself outside the shed zone.
                    // The measured figure when the provider reports one; a local
                    // estimate when it does not. Without the fallback an endpoint
                    // that rejects `stream_options` leaves this at 0 for the rest of
                    // the connection, so the trigger is never crossed and this whole
                    // brake stays disengaged — on exactly the providers that have no
                    // server-side edit to fall back on either.
                    // Passed SEPARATELY, not collapsed with `||` as they were: the two
                    // figures are trustworthy at different moments, and folding them
                    // hid that. `estimatedTokens` is counted only where it will be
                    // read — walking a long list every step to produce a number that
                    // the reported figure then wins over is a per-step cost for
                    // nothing.
                    lastStepContextTokens,
                    ...(stepNumber === 0 || !lastStepContextTokens
                      ? { estimatedTokens: estimatePromptTokens(base) }
                      : {}),
                    messageCount: base.length, stepNumber, armedEarlier: pruneArmedEarlier,
                  });
                  if (next !== pruneBoundary) {
                    tlog.info("pruning tool traffic mid-turn", {
                      stepNumber, contextTokens: lastStepContextTokens, triggerAt: intraTurnPruneAt,
                      boundaryFrom: pruneBoundary, boundaryTo: next, messages: msgs.length,
                    });
                    pruneBoundary = next;
                    // Only a real advance gets here: a rebuilt history too short to shed
                    // yields a cut at or behind the boundary, so `next` stays equal to it
                    // and the turn is not recorded as having armed.
                    pruneArmedEarlier = true;
                  }
                  msgs = pruneTurnToolTraffic(msgs, pruneBoundary);
                }
                // Moving cache breakpoint on the step tail (see markStepTail for why
                // it clones): without it, everything a tool loop appends sits beyond
                // the turn's last breakpoint and is re-billed as fresh input on every
                // step. The namespace is Anthropic's, so other providers ignore this
                // marker — and on OpenAI there is nothing to add: implicit caching is on
                // by default and already places a breakpoint on the latest user or tool
                // message, which is exactly the moving tail hand-rolled here. (GPT-5.6+
                // does expose explicit `prompt_cache_breakpoint` and
                // `prompt_cache_options.ttl`, 1024-token minimum, if that stops holding.)
                msgs = markStepTail(msgs, stepNumber, ephemeral);
                return {
                  ...stepSettings(stepNumber, 1 - (deadlineAt - Date.now()) / MAX_TASK_MS),
                  // The output-side twin of that wrap-up: a turn whose results have
                  // already added up past the ceiling answers with what it has
                  // instead of gathering more. Same lever, so a turn that hits both
                  // is not told two different things.
                  ...(turnOutputChars >= MAX_TURN_TOOL_OUTPUT_CHARS ? { toolChoice: "none" as const } : {}),
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
        // Emits ai.streamText / ai.toolCall under the active turn span. Built by
        // telemetryFor, never inline: the SDK treats an omitted recordInputs as
        // `true`, so a hand-written literal is one missing field away from
        // shipping prompts and tool results off-host.
        experimental_telemetry: telemetryFor("capka.turn.llm", { "capka.task.id": taskId }),
      });
    };

    let effectNote: ModelMessage | null = null;
    const carryEffectsIntoRestart = () => {
      if (effectNote) {
        const i = modelMessages.indexOf(effectNote);
        if (i >= 0) modelMessages.splice(i, 1);
        effectNote = null;
      }
      const note = buildRecoveryNote([...inheritedEffects, ...turnEffects]);
      if (!note) return;
      // A user turn, not an assistant prefill: it is state the model must read, and
      // a prefill 400s on modern Anthropic anyway.
      effectNote = { role: "user", content: note };
      modelMessages.push(effectNote);
      tlog.info("stating what already ran to the next stream", {
        inherited: inheritedEffects.length, effects: turnEffects.length, noteChars: note.length,
      });
    };

    // Stated to the FIRST stream too, not only from discardPartial. A continuation is a
    // fresh turn whose predecessor failed part-way: nothing has restarted, yet the calls
    // it must not repeat are already invisible in the transcript it was handed. A no-op
    // when both ledgers are empty, since buildRecoveryNote returns null. It has to sit
    // ABOVE this line because streamText is invoked eagerly inside makeStream, so an
    // injection after it would reach only the retries.
    carryEffectsIntoRestart();
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
      if (liveUsage.input || liveUsage.output || liveUsage.cached || liveUsage.cacheWrite) hadDiscard = true;
      discarded.input += liveUsage.input;
      discarded.output += liveUsage.output;
      discarded.cached += liveUsage.cached;
      // Banked like the rest: the tokens a discarded attempt wrote to the cache were
      // billed, so dropping them here would under-charge the reconciliation below.
      discarded.cacheWrite += liveUsage.cacheWrite;
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
      // The discarded attempt's ending says nothing about the one replacing it. Left
      // standing, a discarded "length" would report the NEXT attempt as cut off even
      // when that one ended cleanly (or died before emitting any step at all).
      lastFinishReason = undefined;
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
    const doFlush = async () => {
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
    // Serialize flushes: the timer fires while a previous flush may still be
    // awaiting Postgres, and unchained they'd stack concurrent queries on the
    // shared NOTIFY client without bound when the DB lags (each pending flush
    // pinning its deltas in memory). Chaining caps it at one running + one
    // queued: a flush that hasn't started yet will drain whatever is in the
    // buffers by the time it runs, so further callers just share its promise.
    // The chain itself swallows the failure (one lost NOTIFY must not wedge
    // every later flush); the caller-facing promise still rejects for `await`s.
    let flushChain: Promise<void> = Promise.resolve();
    let queuedFlush: Promise<void> | null = null;
    const flushBuffers = () => {
      if (queuedFlush) return queuedFlush;
      const run = flushChain.then(() => {
        queuedFlush = null; // started — the next caller must queue a fresh one
        return doFlush();
      });
      queuedFlush = run;
      flushChain = run.catch(() => {});
      return run;
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
    // The ledger's other half: recording an executed call is useless if the restart
    // never reads it. Owned here rather than repeated at each retry, because there
    // are FIVE restart branches and three of them had re-derived nothing at all —
    // a turn could run a write, hit a rejected `reasoning_content` echo on the next
    // step, and start over blind to the write it had just made.
    //
    // Idempotent by identity: a second restart REPLACES its predecessor's note
    // instead of stacking another copy of a list that only grows. It survives the
    // echo branch's `foldReasoningIntoText` rewrite for free — that maps assistant
    // messages and returns every other message unchanged, so this user turn comes
    // back as the same object.

    const discardPartial = async () => {
      // NOT cleared here: `turnEffects`. Everything else in this function is about
      // the abandoned attempt's PRESENTATION — text, timings, tool counts the user
      // never saw land. Executed tool calls are not presentation: they happened,
      // and they stay happened after the attempt is thrown away. Clearing them is
      // what made a restarted turn repeat its writes.
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
      // Same reasoning as the tool count: windows from a thrown-away attempt would
      // credit this turn with files the user never saw it produce.
      toolStartedAt.clear();
      toolWindows = [];
      currentStatus = { kind: "thinking" };
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      // Wiping `parts` is exactly what blinds the next stream to this turn's own
      // writes, so the statement of what already ran goes in at the same moment.
      carryEffectsIntoRestart();
      await publishTaskEvent(userId, { type: "task:reset", taskId, chatId, messageId: msgId, seq: ++seq });
    };

    let retried = false;
    const consume = async () => {
      // Arm the stall watchdog for this attempt: it fires only while we're waiting
      // on the model (paused during local tool runs) and is torn down whatever way
      // the loop ends (clean finish, abort event, or throw). A retry is twice as
      // patient as the first try: the first attempt must fail FAST on a hung
      // gateway, but once we've seen one stall the likelier story is a model that
      // is alive and thinking longer than the base window (a reasoning phase the
      // provider doesn't stream looks identical to silence on the wire), and
      // retrying it with the same window just fails the same way three more times.
      // Doubling once, not per attempt, keeps the worst case (60s + 3×120s) inside
      // MAX_TASK_MS, so an exhausted turn still reports "provider unresponsive"
      // rather than being cut off as a generic timeout.
      watchdog.start(recoveries > 0 ? STREAM_IDLE_MS * 2 : STREAM_IDLE_MS);
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
            if ("invalid" in event && event.invalid) invalidCalls.add(event.toolCallId);
            // Strip NUL from the model-generated args before they enter `parts`
            // (a model can emit a literal NUL escape in a JSON string arg, which
            // is valid JSON but breaks the jsonb write). Completes the "parts never
            // carry NUL" invariant across every source.
            const input = stripNul(event.input);
            toolStartedAt.set(event.toolCallId, Date.now());
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
            closeToolWindow(event.toolCallId);
            await flushBuffers();
            // Trust boundary: a tool can return raw binary (e.g. a PNG dumped as
            // `output.content`) whose NUL bytes Postgres rejects in both `jsonb`
            // and `pg_notify`. Strip them once, here, so neither the DB write nor
            // the realtime publish below can choke. See stripNul.
            const output = stripNul(event.output);
            // THE TAINT MARK, and it is here rather than inside `withEffectLedger`
            // because this is the ONLY place the runner sees a result at all — the
            // ledger's wrapper never runs for a provider-executed tool, which has no
            // local `execute` and is returned untouched.
            //
            // Decided PER RESULT from the tool's own registration, not unconditionally:
            // marking everything here would make `untrustedOutput: false` dead code one
            // layer down, which is a stated exception that a second entrance walks past.
            // `rawTools` is the pre-wrap set the runner still holds, so the declaration
            // is readable by name; a tool that is absent from it (provider-executed) has
            // no local execute and is untrusted by definition — a provider-side fetch is
            // not Capka-authored. UNSET is untrusted, which is the whole fail-closed
            // property now that the fold's own predicate is not a second belt.
            if (untrustedOutputOf(rawTools, event.toolName)) await taint.mark("tool_result");
            parts.push({ type: "tool-result", id: event.toolCallId, name: event.toolName, output });
            turnOutputChars += outputChars(output);
            // Ledger of what this turn has actually DONE — recorded on the result,
            // so it means "ran", not "was asked for". Unlike `parts` it survives a
            // discard, because the emergency context-overflow retry re-streams from
            // settled history and would otherwise restart blind to live side
            // effects. See effect-ledger.
            turnEffects.push({ id: event.toolCallId, name: event.toolName, input: event.input });
            // In memory for a restart inside this process; in the table so a restart
            // in ANOTHER task still sees it. Awaited, because a restart that begins
            // before the write lands starts blind — the one thing this prevents.
            await recordEffect({ messageId: msgId, toolCallId: event.toolCallId, taskId, name: event.toolName, input: event.input });
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
            // A failed tool still had its hands on the workspace (a script can
            // write three files and then throw), so its window counts.
            closeToolWindow(event.toolCallId);
            await flushBuffers();
            // Strip NUL like every other string entering `parts`: a tool can throw
            // an error whose message embeds raw binary, which would otherwise break
            // the jsonb metadata write the same way a binary tool-result would.
            const toolErr = stripNul(errMsg(event.error));
            const neverRan = invalidCalls.has(event.toolCallId);
            parts.push({ type: "tool-error", id: event.toolCallId, name: event.toolName, error: toolErr, ...(neverRan ? { invalid: true } : {}) });
            turnOutputChars += toolErr.length;
            // Ledgered too, and marked failed. Same reason the window counts above:
            // a tool that throws may have written first, so this is the entry a
            // restarted turn most needs — "did this land?" cannot be answered from
            // the transcript and has to be verified.
            if (!invalidCalls.has(event.toolCallId)) {
              turnEffects.push({ id: event.toolCallId, name: event.toolName, input: event.input, failed: true });
              await recordEffect({ messageId: msgId, toolCallId: event.toolCallId, taskId, name: event.toolName, input: event.input, failed: true });
            }
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
            // The LAST step's reason is the turn's: intermediate steps of a tool loop
            // all finish as "tool-calls", so only the final assignment survives to say
            // how the turn actually ended.
            lastFinishReason = event.finishReason;
            stepCount++;
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
            // Renew the lease BEFORE persisting anything. The renewal is refused
            // once the lease has expired (a GC pause, a frozen event loop, a DB
            // stall longer than LEASE_SECONDS), and by then the zombie reconciler
            // has already declared this turn interrupted and another worker may own
            // the workspace. Writing the snapshot first would put this run's state
            // on a message row it no longer owns — the same two-writers hazard the
            // lease exists to prevent, just one step earlier than the CAS at the
            // end catches it. So: stand down exactly like the monitor does, and let
            // the terminal path report `leaseLost`.
            if (!(await heartbeat(taskId, workerId))) {
              leaseLost = true;
              ac.abort();
              break;
            }
            // Flush buffered text and force a snapshot (streamSeq + parts).
            // force=true bypasses the ~1s throttle so each step boundary is
            // durably persisted.
            await flushBuffers();
            await saveSnapshot(true);
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
      // MUST be tested before isReasoningUnsupportedError: some backends phrase an
      // out-of-range effort with words that classifier also matches ("Invalid
      // value: 'medium'. Supported values are …"), and dropping reasoning there
      // would silently take away the thinking the user asked for when a legal
      // value was available all along.
      const allowed = useReasoning && !effortNegotiated ? parseAllowedEfforts(err) : null;
      if (allowed) {
        // The model accepts reasoning, just not at this level, and it listed what
        // it does accept. Re-map the SAME intent onto its enum and re-stream —
        // then remember the enum so no later turn (for anyone) pays this retry.
        effortNegotiated = true;
        // Clamp the intent onto the enum first: a model with a single "on" level
        // (Groq's Qwen: none|default) has no value for "deep", and snapping to the
        // nearest level it DOES have keeps the thinking the user asked for instead
        // of dropping it. The UI narrows to these same stops from the next turn.
        const snapped = clampAmount(thinkAmount, availableAmounts(provider, allowed));
        const retryParams = reasoningParams(provider, snapped, allowed);
        tlog.info("reasoning effort rejected — retrying with the model's own enum", { allowed, thinkAmount, snapped });
        void rememberModelEfforts(modelId, provider, allowed).catch((e) =>
          tlog.warn("could not persist learned reasoning efforts", { error: errMsg(e) }),
        );
        reasoning = retryParams;
        useReasoning = retryParams !== undefined; // no legal value for this stop → think silently
        streamError = undefined;
        await discardPartial();
        foldDiscarded();
        result = makeStream();
        await consume();
        return true;
      }
      if (useReasoning && isReasoningUnsupportedError(err)) {
        // Model can't reason — re-stream without the reasoning knobs. Reset parts
        // defensively so a retry can't duplicate output.
        tlog.info("reasoning unsupported — retrying without it");
        // Remember it, so this costs ONE request per model rather than one per
        // turn — the same bargain the effort-enum branch above makes. Fire and
        // forget: the retry below must not wait on a write, and a failed write
        // only means the next turn re-learns it.
        void rememberModelCannotReason(modelId, provider).catch((e) =>
          tlog.warn("could not persist that the model cannot reason", { error: errMsg(e) }),
        );
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
      if (isStreamUsageRejectedError(err) && disableStreamUsage(configId)) {
        // This endpoint refuses `stream_options` — our ask for token counts on the
        // stream (providers/stream-usage.ts). The ask has no bearing on the ANSWER,
        // so re-stream without it rather than failing the user's turn. No rebuilt
        // model: the ask is stripped per request, so this same instance now sends a
        // body the endpoint accepts. The cost is that this turn — and every later
        // one on this connection, until a restart — records no token counts, exactly
        // as it did before we started asking. `disableStreamUsage` returning false
        // is what stops a rejection that survives the retry from looping.
        tlog.info("provider rejects stream_options — retrying without usage reporting");
        streamError = undefined;
        await discardPartial();
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
      // The rejection usually names the real window. Remember it so this
      // overflow is paid once per model: the next turn's budget compacts against
      // the figure the provider just enforced instead of the catalog's (or the
      // default's) guess. Fire and forget, like the reasoning-effort memo above.
      const realWindow = parseContextWindow(err);
      if (realWindow && realWindow !== contextLength) {
        tlog.info("context overflow named the model's window — remembering it", { realWindow, assumed: contextLength });
        void rememberModelContextLength(modelId, provider, realWindow).catch((e) =>
          tlog.warn("could not persist learned context window", { error: errMsg(e) }),
        );
      }
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
      // Again, because the line above REPLACED the list discardPartial had just put
      // the note on. The trim keeps SETTLED turns, so by construction it drops
      // everything this turn did — and this note is the only thing between an
      // overflow and a duplicate create.
      carryEffectsIntoRestart();
      markCacheTail(modelMessages); // fresh objects — re-mark the cache tail
      // Re-attach the turn's native files (the trim+reconvert produced fresh
      // model messages, dropping the bytes injected into the original set).
      if (injectedNative && nativeFiles.length) {
        // Same row id as the first injection — missing it here would drop the mark on
        // exactly the turn that overflowed. Monotonic, so the repeat is a no-op.
        await injectNativeFiles(modelMessages, sessionKey, userId, provider, nativeFiles, replyParentId ?? msgId);
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
        // A lost ledger write must not be re-read as a provider hiccup: a Postgres
        // blip classifies as `network`, so the transient branch below would
        // re-stream and carry on with an executed call unrecorded — losing the
        // durability this is all for. recordEffect already retried; fail the turn.
        if (e instanceof EffectLedgerError) throw e;
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
        await new Promise((r) => setTimeout(r, 1000));
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

    // The model stopped because it ran out of output room, not because it was done.
    // Ranked LAST in both chains below: every other condition is a stronger statement
    // about the same turn — a cancel, a lost lease or a provider error explains the
    // short reply better than the length limit does. A suspended turn is excluded
    // outright: it stopped to ask, and its final step is a tool call, not a cut-off.
    const truncated = lastFinishReason === "length" && !awaitingApproval && !awaitingAnswer;
    if (truncated) {
      tlog.warn("model output hit the length limit; the reply is cut off", {
        model: modelId, provider, steps: stepCount,
      });
    }
    // `parts` is not the whole story: discardPartial empties it when an attempt is
    // thrown away and keeps the executed-call ledger, so a failure right after a
    // restart has writes standing with nothing in parts to show for them.
    //
    // Nor is the in-memory mirror: it only learns of a call when its RESULT arrives, and
    // a tool still running when the deadline fires never produces one. Its write-ahead
    // row is already on disk, so the ledger is the only thing that knows the workspace
    // may have been touched — the same second source the SQL twin needed, on this side.
    // Asked only on a path that will actually form a verdict, because this line runs on
    // every turn; and a failed read answers TRUE, since "you may have work, continue" is
    // the recoverable mistake and "start over" duplicates writes that already landed.
    const hadEffects = turnEffects.length > 0
      || ((deadlineHit || leaseLost || stalledOut)
          && await loadEffects(msgId).then((r) => r.length > 0, () => true));
    const finalStatus = deadlineHit ? "failed" : leaseLost ? "failed" : ac.signal.aborted ? "cancelled" : (stalledOut || streamError) ? "failed" : truncated ? "failed" : "completed";
    // Map any provider error to a friendly, role-aware shape: users see
    // `error`, admins can expand `errorDetail`. Raw text stays in tasks.error.
    // A stall-out gets its own category (distinct from a clean timeout) so the
    // user is told to retry/switch models rather than "shorten your request" —
    // and a two-way split within it, because a stall that hit mid-work must not
    // advise "try again": regenerating re-runs every tool and rewrites what this
    // turn already wrote. `parts` is what the turn is keeping, so it decides.
    const failure = deadlineHit ? timedOutError(parts, hadEffects) : leaseLost ? interruptedError(parts, hadEffects) : stalledOut ? providerUnresponsiveError(parts, hadEffects) : streamError ? classifyLLMError(streamError) : truncated ? RESPONSE_TRUNCATED_ERROR : undefined;

    // Token usage + cost, computed once. Needed BOTH for the persisted message
    // metadata (so the (i) details survive a reload — elapsedMs and the usage
    // table are otherwise lost to the UI) and for the usage table below. Never
    // fatal: a failure here just omits the numbers from metadata. `inputTokens`
    // is the TOTAL input incl. cached reads, so split it — non-cached at the
    // input rate, cached reads at the discounted rate (avoids double-counting).
    // Usage from the live accumulator (robust to cancel/abort), not result.totalUsage.
    const usageMeta = liveUsage.input || liveUsage.output || liveUsage.cached || liveUsage.cacheWrite
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
          // Billed above base input, and NOT part of `usageMeta.input` (the SDK's
          // noCacheTokens excludes them) — so this is the charge, not a duplicate.
          cacheWriteTokens: usageMeta.cacheWrite,
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
    // Drives the compaction trigger below. It used to feed a second consumer — the
    // memory pass rode the hot prefix when the chat was long — but candidate
    // extraction sees one turn, not the conversation, so it makes the same small
    // standalone call either way.
    const budget = usageMeta
      ? contextBudget({ usedTokens: lastStepContextTokens, modelContextLength: contextLength, adminCap: adminCap || null })
      : undefined;

    // The reasoning/tool phase = start → first answer token (or the whole run if
    // it never produced answer text). Persisted so a reloaded transcript shows
    // the real "reasoned for …" time, not the full turn duration.
    const reasoningMs = (firstTextAt ?? Date.now()) - startedAt;

    // Files this turn changed that the reply never names. Tier one (the paths the
    // model wrote out) is derived client-side from the same text, so only the
    // remainder is persisted — the transcript folds it behind "Also changed".
    //
    // Deliberately fail-soft and last-thing-before-the-write: the workspace may be
    // gone (idle-evicted), the controller may be down, or the listing may time
    // out. None of that is worth failing a finished turn over — the user still
    // gets their answer, just without the secondary file list.
    let touchedFiles: string[] | undefined;
    if (toolWindows.length > 0) {
      try {
        const named = extractWorkspacePaths(getFullText());
        const { entries } = await listFiles(sessionKey, ".", userId, WORKSPACE_SCAN_DEPTH, WORKSPACE_SCAN_LIMIT);
        const touched = selectTouchedFiles(entries ?? [], toolWindows, named);
        if (touched.length > 0) touchedFiles = touched;
      } catch (e) {
        tlog.debug("artifacts.scan_skipped", { err: errMsg(e) });
      }
    }

    // The message row carries the WHOLE turn, which for an approval continuation is
    // this run plus the half that ran before the user clicked. Everything below this
    // point that reports per-RUN facts — the `usage` ledger, the turn span, the log
    // line, the channel footer — deliberately keeps using the un-folded figures.
    const turn = foldTurnHalves(
      { usage: usageMeta, costUsd: costMeta ?? undefined, costSource, durationMs: Date.now() - startedAt, reasoningMs, llmCalls: stepCount },
      prior,
    );

    // The [N] markers this reply carries, resolved against branch + own sources
    // (numbers are branch-unique — see the seed at the path load — so a
    // follow-up may legitimately cite a source a PREVIOUS turn's search
    // produced). The resolved subset is persisted on the message: the web
    // client renders chips/footer per message and cannot see other rows'
    // parts, so a cross-turn citation would otherwise be inert there.
    const turnSourceMap = new Map<number, NumberedSource>();
    for (const s of branchSources) turnSourceMap.set(s.n, s);
    for (const p of parts) {
      if (p.type !== "tool-result") continue;
      for (const s of sourcesFromOutput(p.output) ?? []) turnSourceMap.set(s.n, s);
    }
    const citedLean = turnSourceMap.size
      ? citedSources(getFullText(), [...turnSourceMap.values()]).map(({ n, title, url }) => ({ n, title, url }))
      : [];

    const outcomeMeta: MessageMeta = {
        // A suspended turn is NOT done — mark it so the presenter maps the pending
        // tool call to its card state (approval-requested / ask input-available),
        // not an orphan error, and the client blocks the composer until the user
        // decides/answers.
        taskId, status: awaitingApproval ? "awaiting_approval" : awaitingAnswer ? "awaiting_answer" : finalStatus, parts: parts.length > 0 ? parts : undefined,
        ...(failure ? { error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category, errorOwned: ownKey } : {}),
        // How long the thinking/tool phase ran, on EVERY outcome — this one is not
        // a tech detail, it's the activity group's own header. A turn that broke
        // after three minutes should still say it thought for three minutes;
        // withholding it left the failed turns in the transcript labelled with a
        // bare "Reasoning", which reads as if nothing had happened at all.
        reasoningMs: turn.reasoningMs,
        ...(touchedFiles ? { touchedFiles } : {}),
        ...(citedLean.length ? { citedSources: citedLean } : {}),
        // On EVERY outcome, not just the successful ones: a failed turn's message
        // still sits on the path the next turn reads, and this is how that turn
        // learns clearing is already on (see shouldClearToolResults).
        ...(toolsCleared ? { toolsCleared: true } : {}),
        ...(contextDeep ? { contextDeep: true } : {}),
        // Tech details for the (i) popover. A manual cancel still did real work
        // (it has a model, elapsed time, and billed tokens), so carry them too —
        // otherwise the stopped turn loses its (i) affordance. A failed turn owns
        // the ErrorNotice instead, so it stays excluded.
        ...(finalStatus === "completed" || finalStatus === "cancelled" ? {
          durationMs: turn.durationMs,
          // The reply's own request count, so the popover can account for every call
          // the message caused. Inside the completed/cancelled branch with the rest
          // of the (i) figures: a failed turn owns the ErrorNotice instead.
          ...(turn.llmCalls ? { llmCalls: turn.llmCalls } : {}),
          // The model of the LAST half. One field can't describe two halves that
          // resolved different models, and the later one is what produced the text
          // the user is reading; the cost above is still the sum of both halves,
          // each priced against its own model.
          model: modelId,
          ...(turn.usage ? { usage: turn.usage } : {}),
          ...(turn.costUsd != null ? { costUsd: turn.costUsd } : {}),
          ...(turn.costSource ? { costSource: turn.costSource } : {}),
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
    };

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
        taskId, messageId: msgId, userId, provider, configId, model: modelId, onSharedKey: isShared,
        usage: {
          inputTokens: usageMeta.input + discarded.input,
          outputTokens: usageMeta.output + discarded.output,
          cachedInputTokens: usageMeta.cached + discarded.cached,
          // The fourth billable bucket, and the one the ledger silently lost: the
          // SDK's noCacheTokens EXCLUDES cache writes, so they are in neither
          // `input` nor `cached`. Omitting it here both under-stated the stored
          // token total and — on the catalog-recompute branch below, where
          // `folded` is undefined — re-derived the cost from a bucket short of
          // every write token, undoing the pricing fix for direct providers.
          cacheWriteTokens: (usageMeta.cacheWrite ?? 0) + discarded.cacheWrite,
        },
        costUsd: folded,
      });
    }

    // Claim the right to say how this turn ended, and write the message with it, in
    // one transaction. Everything after this point is that claim being acted on —
    // the realtime event, the automation streak, the channel push, the follow-up
    // work — so all of it hangs off the same answer.
    const owned = await commitTurnOutcome({
      taskId, workerId, status: finalStatus,
      error: failure?.adminDetail ?? streamError ?? null,
      message: { id: msgId, content: getFullText(), metadata: outcomeMeta },
    });
    if (!owned) {
      // The zombie reconciler got here first (our lease expired) and has already
      // told the user this turn was interrupted. Its verdict stands: publishing a
      // completed event or pushing the answer to Telegram now would contradict what
      // they were shown, which is the exact flip the CAS exists to prevent. The
      // spend is already settled above — that part is ours either way. An
      // automation's streak goes unrecorded here, same as after a hard crash.
      tlog.warn("turn outcome was already settled elsewhere (lease lost); standing down", { attempted: finalStatus });
      // Say so on the span too, or it would close as the success it never became.
      setTurnOutcome({ status: "failed" as TurnStatus, keyShared: runShared, tools: toolCount, errorCategory: "interrupted" });
      return; // `finally` still releases the hold and closes the MCP clients
    }
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
      // The shape a provider will not tell us, and the reason an opaque 400 used to
      // be undiagnosable: the raw text landed in the DB, but nothing said how deep
      // the turn was when it arrived. On the same record rather than a second one —
      // this line already carries the error, so a separate log would only duplicate.
      contextTokens: lastStepContextTokens,
      messages: modelMessages.length,
      ...(recoveries ? { recoveries } : {}),
      ...(turnOutputChars ? { toolOutputChars: turnOutputChars } : {}),
    });
    // Same facts onto the turn span (the worker owns its lifecycle; we only report).
    // Cost is passed but NOT exported by default — the `usage` ledger is the money
    // truth, and a second dollar figure in a tracing backend would be a second
    // answer to the same question (CAPKA_TELEMETRY_COST=true to consolidate there).
    setTurnOutcome({
      status: finalStatus as TurnStatus,
      ...(usageMeta ? { usage: { input: usageMeta.input, output: usageMeta.output, cached: usageMeta.cached, cacheWrite: usageMeta.cacheWrite, reasoning: usageMeta.reasoning } } : {}),
      contextTokens: lastStepContextTokens,
      ...(costMeta != null ? { costUsd: costMeta } : {}),
      ...(costSource ? { costSource } : {}),
      keyShared: runShared,
      tools: toolCount,
      ...(hadDiscard ? { discardedTokens: discarded.input + discarded.output } : {}),
      ...(firstTextAt ? { firstTextMs: firstTextAt - startedAt } : {}),
      modelFinal: modelId,
      steps: stepCount,
      recoveries,
      stalled: stalledEver,
      ...(failure?.category ? { errorCategory: failure.category } : {}),
    });
    // Build the Telegram approval payload (buttons + preview) only on an origin
    // channel — the web card fetches its own preview, so this query is skipped there.
    let telegramApproval: { messageId: string; toolCallId: string; title: string; tool?: string; before: string; after: string; impact?: string; body?: string; items?: string[]; truncated?: boolean } | undefined;
    if (awaitingApproval && payload.origin) {
      // The preview must describe the SAME call the tap will decide. A step can
      // suspend several gated calls at once, and a decision that arrives without a
      // toolCallId resolves to the FIRST undecided one (authed.ts) — so the card is
      // built from that first undecided part, never from the last-suspended scalar,
      // and its id travels in the payload so the callback can pin it explicitly.
      // Review finding (gpt-5.6-sol): a card showing call B must not approve call A.
      const callPart = parts.find(
        (p): p is Extract<StoredPart, { type: "tool-call" }> =>
          p.type === "tool-call" && !!p.approval && p.approval.approved === undefined,
      );
      const input = callPart?.input;
      const toolName = callPart?.name;
      if (callPart && toolName === "manage") {
        const { previewManageForUser } = await import("@/lib/manage/authed");
        // Pass the run's sandbox session so a workspace-path preview reads the real files, and
        // the call id so a preview that resolves a moving target pins what these buttons will
        // show — without it a Telegram approval of a repo install has no review to apply and
        // (correctly, but pointlessly) refuses.
        const pv = await previewManageForUser(userId, input, { sessionKey, toolCallId: callPart.id }).catch(() => null);
        if (pv) telegramApproval = { messageId: msgId, toolCallId: callPart.id, title: pv.title, before: pv.before, after: pv.after, impact: pv.impact, body: pv.body, items: pv.items };
      } else if (callPart && toolName) {
        // A governance-"ask" tool (a connector's tool, or a skill): there is no
        // staged change to diff — show WHAT would run (`tool`, localized into a
        // title by the delivery layer) and the raw arguments behind "Details".
        // The label is the consent headline and tool names come from untrusted MCP
        // servers, so it is flattened to one plain line before it can reach a
        // Markdown surface — no newlines, links, or backticks survive.
        const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
        const rawLabel = mcp ? `${mcp[1]}: ${mcp[2]}`
          : toolName === "skill" && input && typeof input === "object" && typeof (input as { name?: unknown }).name === "string"
            ? (input as { name: string }).name
            : toolName;
        const label = rawLabel.replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ._:/-]/gu, "").slice(0, 120).trim() || "tool";
        let args = "";
        try { args = JSON.stringify(input, null, 2) ?? ""; } catch { /* unserializable input — approve on the label alone */ }
        // A truncated argument list cannot be consented to — a benign prefix could
        // hide a destructive tail. The flag makes the delivery layer withhold the
        // buttons and point at the web card, which always shows the full call.
        const truncated = args.length > 1500;
        if (truncated) args = `${args.slice(0, 1500)} …`;
        telegramApproval = {
          messageId: msgId, toolCallId: callPart.id, title: "", tool: label, before: "", after: "",
          ...(args && args !== "{}" ? { body: args } : {}),
          ...(truncated ? { truncated: true } : {}),
        };
      }
    }
    // A suspended `ask` on an origin channel starts a sequential field-by-field
    // collection there (the web card fills the same role in the browser).
    const telegramAsk = awaitingAnswer && payload.origin
      ? { messageId: msgId, form: awaitingAnswer.form, userId }
      : undefined;
    // The same resolved subset the message metadata carries (`citedLean`) —
    // Telegram appends it as a quoted "Sources:" footer.
    const telegramSources = payload.origin ? citedLean : [];
    try {
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
        ...(telegramSources.length ? { sources: telegramSources } : {}),
      });
    } catch (e) {
      // Execution truth is already durable in tasks/messages. An outbound channel
      // outage is a delivery failure, not a model failure, and must never rewrite a
      // completed task to failed via the runner's outer catch.
      tlog.warn("final result delivery failed", {
        platform: payload.origin?.platform ?? "web",
        status: finalStatus,
        err: String(e),
      });
    }
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

    // Mine the finished turn for durable facts (fire-and-forget). Each one lands in
    // the candidate ledger and waits for a person; the agent's own deliberate path is
    // `memory_fact_write`, which since slice 2 writes STRAIGHT to memory rather than to
    // this ledger, so the two no longer land in the same place. Extraction is the
    // after-the-fact sweep for what the agent did not think to save.
    // Gated on a clean completion (like the title): a cancelled/failed
    // turn shouldn't quietly spend tokens mining facts the user may have aborted.
    //
    // What the user said this turn is `userTurnText`, taken off the bundle — the SAME
    // value the write tools locate a quote in (§4.5 rule 1), and deliberately not
    // re-derived here.
    // The old derivation read `modelMessages.findLast(role === "user")`, which is not
    // the transcript: `carryEffectsIntoRestart` pushes the recovery note onto it as a
    // user message and nothing takes it off again, so every turn that continued after a
    // part-way failure asked "did the user write these words" about a list of tool names
    // and clamped tool ARGUMENTS — text a fetched page can reach. Two derivations of one
    // concept was the defect; one value with one source is the fix, so nothing here may
    // reconstruct it a third time.
    //
    // Its emptiness has consequences beyond this call and they are all fail-safe: an
    // approval/`ask` continuation carries `uiMessages: []`, so nothing is mined from
    // that half of the turn rather than something being mined from the wrong text.
    // `userSpaceId` is absent exactly when memory is off, so it carries the same
    // gate the capability check does — but both are stated, because the space is
    // what the write actually needs and a widened capability must not silently
    // start writing into a space nobody resolved.
    // `background.factExtraction` sits INSIDE the memory capability, not beside it:
    // the capability decides whether this run has memory at all, the pass decides
    // whether a finished turn is swept for what the agent didn't deliberately save.
    // An operator who wants memory but not a request per turn turns off the pass.
    if (profile.background.factExtraction && profile.capabilities.memory && userSpaceId && finalStatus === "completed" && !awaitingApproval && !awaitingAnswer && userTurnText.trim()) {
      // trackAux: keep the worker's shutdown drain waiting on this fire-and-forget
      // call so a deploy doesn't kill it mid-flight (lost spend / dropped facts).
      void trackAux(extractFacts({
        userSpaceId,
        projectSpaceId,
        // The assistant row this turn is writing — the same id the snapshots use, so
        // every saved fact's origin and evidence point at the message it came from.
        messageId: msgId,
        taskId,
        userText: userTurnText,
        assistantText: getFullText(),
        // §4.5's class computation reads the TURN's fold, and the runner is the only
        // place that holds it: `taint` is per-MESSAGE and seeded from the row, so a
        // resumed continuation carries half 1's marks instead of recomputing false.
        // Read at DISPATCH, exactly as the compaction call below reads it — extraction
        // runs after the reply is delivered and nothing marks the turn after that.
        untrustedIngressSeen: taint.seen(),
        // The module knows nothing about providers or usage accounting; binding
        // model/provider and billing the spend to this turn's key is the call site's
        // job. Labelled "memory" so the aux span says which pass it was.
        generate: async (args) => {
          const on = await auxTarget();
          const { text, finishReason, usage } = await auxGenerate(on.model, on.provider, args, "memory");
          const billable = toTokenUsage(usage);
          if (billable) auxUsageRecorder("memory", on)(billable);
          return { text, finishReason };
        },
      })
        // The notice is a PROJECTION, so nothing here has a list to hand the client — only
        // the news that there is something new to read. Fired after the pass resolves,
        // unconditionally: this call writes nothing when the turn had nothing worth
        // saving, and a reload that finds no writes renders no notice, which is cheaper
        // than a second query here to decide whether to publish.
        .then(() => publishTaskEvent(userId, { type: "chat:memory_saved", chatId, messageId: msgId }))
        .catch((e) => tlog.error("memory extraction failed", { err: String(e) })));
    }

    // Auto-title the chat on its FIRST completed turn. "First turn" = no prior
    // assistant message in the history — a migration-free sentinel for "new chat"
    // that also never clobbers a title the user renamed by hand on a later turn.
    // The slice-of-first-message placeholder set by /api/chat stays visible until
    // this lands, so the sidebar always shows *something* in the meantime.
    //
    // Read off `uiMessages` and NOT `modelMessages`, and excluding the row this task is
    // writing. Both halves matter for the same case: a chat whose first turn goes
    // through an `ask` suspends, and the continuation answers from the SAME assistant
    // row (`replyParentId = resumeMessageId`), which is therefore on the path — so the
    // plain probe read "not the first turn", the first half was skipped by
    // `!awaitingAnswer`, and every later turn was skipped too. Such a chat kept the
    // `/api/chat` placeholder (a 100-char slice of the opening message) forever.
    // `modelMessages` is also the wrong list on its own terms: the emergency trim
    // replaces it with only the most recent turns, which reads as a first turn in a
    // conversation of any depth.
    const isFirstTurn = !uiMessages.some((m) => m.role === "assistant" && m.id !== resumeMessageId);
    if (profile.background.autoTitle && finalStatus === "completed" && !awaitingApproval && !awaitingAnswer && isFirstTurn) {
      void trackAux(
        (async () => {
          // The chat's OWN opening message, not `userTurnText`. These are different
          // questions — "what did the user type this turn" vs "what did this chat open
          // with" — and only the second one has an answer on a continuation, where
          // `uiMessages` is empty and `userTurnText` is "" by design (see
          // `run-context.ts`). Sourced from the message ROW because a row survives a
          // continuation; re-deriving it from `modelMessages` is what F1 was and must
          // not come back. Rides idx_messages_chat_role_created.
          const [opening] = await db
            .select({ content: messages.content })
            .from(messages)
            .where(and(eq(messages.chatId, chatId), eq(messages.role, "user")))
            .orderBy(asc(messages.createdAt))
            .limit(1);
          const openingText = opening?.content?.trim();
          if (!openingText) return;
          const on = await auxTarget();
          const title = await generateChatTitle(on.model, on.provider, openingText, getFullText(), auxUsageRecorder("title", on));
          // Settle this pass's accounting BEFORE the event that makes the client
          // re-read the row. `chat:title` is the only signal that a titled turn's
          // background work is done, so publishing ahead of the append means the
          // client fetches the row without it and nothing later corrects that.
          // `allSettled` semantics by hand: a failed write must not skip the title.
          await auxWrites.get("title")?.catch(() => {});
          if (!title) return;
          await db.update(chats).set({ title: stripNul(title) }).where(eq(chats.id, chatId));
          await publishTaskEvent(userId, { type: "chat:title", chatId, title });
        })().catch((e) => tlog.error("chat title generation failed", { err: String(e) })),
      );
    }

    // Compaction. If this turn's INPUT neared the context-window budget, summarize
    // the conversation on the still-hot prefix and write a checkpoint, so the next
    // turn's buildModelContext collapses everything up to it into that summary.
    // Cache-friendly by construction (same system+history, instruction appended as
    // the final user turn — see buildCompactionMessages). Fire-and-forget like
    // title/memory; gated on a clean completion. `used` counts the FULL input
    // (cached reads included), since the whole prefix occupies the window.
    if (profile.background.compaction && finalStatus === "completed" && !awaitingApproval && !awaitingAnswer && budget && budget.shouldCompact) {
      void trackAux(
        // `taint.seen()` at the moment compaction is DISPATCHED, not an OR recomputed
        // over `nodes` — that array is block-scoped inside the `if (replyParentId)` above
        // and is not in scope here. It is already the fold over exactly those rows plus
        // this turn's own marks, and it over-approximates in the safe direction: the
        // summary covers this turn too.
        compactConversation(model, systemMessages, modelMessages, taint.seen(), auxUsageRecorder("compaction"))
          .then(async (result) => {
            if (!result) return;
            const summary = result.text;
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
              // The checkpoint IS a message row, so it carries the same column: the OR of
              // the marks of everything its summary replaced. Written in the SAME insert —
              // a checkpoint that existed for even a moment without its mark is a window
              // in which the next turn folds a compacted prompt clean.
              untrustedIngress: result.trust,
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
    // Same two sources as the finalize path above, and the same reason: the tool that
    // was mid-flight when this threw is in the ledger and nowhere else. Kept eager-but-
    // guarded rather than folded into a shared helper, because the two paths do not
    // share a scope — and a failed read answers TRUE here for the same asymmetry.
    const hadEffects = turnEffects.length > 0
      || ((deadlineHit || leaseLost)
          && await loadEffects(msgId).then((r) => r.length > 0, () => true));
    const failure = deadlineHit ? timedOutError(parts, hadEffects) : leaseLost ? interruptedError(parts, hadEffects) : isAbort ? undefined : classifyLLMError(e);
    // This catch swallows the error to finalize gracefully, so the worker's
    // crash log never fires — record it here instead. A clean cancel is info.
    tlog[status === "cancelled" ? "info" : "error"]("task ended", {
      status, elapsedMs: Date.now() - startedAt, toolCount,
      ...(failure ? { error: failure.adminDetail } : { err: String(e) }),
    });
    const failureMeta = {
      taskId, status, parts: parts.length > 0 ? parts : undefined,
      // Which model failed/was cancelled — without it, model-filtered analytics
      // would silently exclude every failed turn and understate failure rates.
      // Null only when prepareRun threw before a model was ever resolved.
      ...(runModelId ? { model: runModelId } : {}),
      ...(failure ? { error: failure.userMessage, errorDetail: failure.adminDetail, errorCategory: failure.category, errorOwned: ownKey } : {}),
    };
    // Same single decision as the success path: claim the outcome and write the
    // message together, nothing before the claim. If prepareRun threw before the
    // assistant row existed (provider gone, model removed), there is nothing to
    // UPDATE — the row is INSERTed and the chat's leaf moved to it, inside the same
    // transaction, so the failure is a visible message rather than a silent dead end.
    let owned: boolean;
    try {
      owned = await commitTurnOutcome({
        taskId, workerId, status,
        error: failure?.adminDetail ?? null,
        message: {
          id: msgId,
          content: getFullText(),
          metadata: failureMeta,
          ...(messageInserted ? {} : {
            insert: {
              chatId,
              parentId: (payload.uiMessages ?? []).at(-1)?.id ?? null,
              platform: payload.origin?.platform ?? "web",
            },
          }),
        },
      });
    } catch (e) {
      // A throw does NOT prove we don't own the outcome, and it does not prove we do:
      // the COMMIT may have landed with only its response lost, or this session alone
      // may have failed while the reconciler is working fine, or the rollback may be
      // real and nobody owns the turn yet. There is no way to tell them apart here.
      //
      // So this is a deliberate exception to the rule the rest of this file follows,
      // not an application of it: we report a failure WITHOUT confirmed ownership,
      // because this path's whole job is to tell the user something broke and going
      // silent would make the product quiet exactly when it has to speak. What keeps
      // the exception cheap is that every status this path produces is a non-success:
      // the worst case is a failure announced twice, or ahead of the row settling —
      // never the contradicting "interrupted turns into an answer" that the gate on
      // the success path exists to prevent.
      tlog.error("could not confirm ownership of the failure outcome; reporting it anyway", { err: errMsg(e) });
      owned = true;
    }
    if (!owned) {
      tlog.warn("failure outcome was already settled elsewhere (lease lost); standing down", { attempted: status });
      return; // `finally` still releases the hold and closes the MCP clients
    }
    await publishTaskEvent(userId, { type: "task:finish", taskId, chatId, messageId: msgId, status, ...(failure ? { error: failure.userMessage } : {}) }).catch(() => {});
    // This catch path finalizes the turn WITHOUT rethrowing, so the turn span
    // would otherwise close as "completed". Report the real outcome here.
    setTurnOutcome({
      status: status as TurnStatus,
      keyShared: runShared,
      tools: toolCount,
      ...(runModelId ? { modelFinal: runModelId } : {}),
      ...(failure?.category ? { errorCategory: failure.category } : {}),
    });
    try {
      await sink.finish({
        status, text: getFullText(), error: failure?.userMessage, errorDetail: failure?.adminDetail, errorCategory: failure?.category,
        isAdmin: failure ? await resolveIsAdmin() : false,
        toolCount, elapsedMs: Date.now() - startedAt,
      });
    } catch (deliveryError) {
      // The failure itself is already persisted and published to the web. Keep a
      // secondary channel outage observable without letting it escape the runner.
      tlog.warn("failure result delivery failed", {
        platform: payload.origin?.platform ?? "web",
        status,
        err: String(deliveryError),
      });
    }

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
    const spentCacheWrite = liveUsage.cacheWrite + discarded.cacheWrite;
    if (runModelId && (spentInput || spentOutput || spentCached || spentCacheWrite)) {
      // Prefer the provider's authoritative real charge whenever one was reported
      // (this attempt's orLive, plus any discarded attempts'); else let
      // reconcileUsage recompute from the catalog over the combined tokens.
      const orServed = orLive.generationId != null || orLive.upstreamProvider != null;
      const realCost = orServed || discardedOrServed ? orLive.cost + discarded.cost : undefined;
      await reconcileUsage({
        taskId, messageId: msgId, userId, provider: runProvider ?? "shared", configId: runConfigId, model: runModelId, onSharedKey: runShared,
        usage: {
          inputTokens: spentInput, outputTokens: spentOutput, cachedInputTokens: spentCached,
          cacheWriteTokens: spentCacheWrite,
        },
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
