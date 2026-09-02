import type { StoredPart, MessageMeta } from "./contracts";
import type { TurnWrite } from "@/lib/vault/turn-writes";
import { INTERRUPTED_TOOL_RESULT } from "./tool-results";

/**
 * Convert DB message rows to UI message format.
 *
 * `memoryWrites` is what a turn saved to memory, keyed by message id — a PROJECTION the
 * caller reads (see `readTurnWrites`), not a field on the row. It is a second parameter
 * rather than a column on the row shape because most callers of this function are not the
 * web chat: the runner builds the model's own view through it, `share/[token]` renders
 * somebody else's conversation, and Telegram has no notice to render. A row shape carrying
 * the field would make every one of them either supply it or explain why not, and the
 * share page supplying it would be a real leak rather than an omission. Omitted, no
 * message carries the metadata and nothing is rendered.
 */
export function toUIMessages(rows: {
  id: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: Date | null;
  platform: string | null;
  parentId?: string | null;
  /** Position among siblings (0-based) — drives the "‹ i/N ›" version switcher. */
  siblingIndex?: number;
  siblingCount?: number;
}[], memoryWrites: Record<string, TurnWrite[]> = {}) {
  return rows.map((m) => {
    const meta = m.metadata as MessageMeta | null;
    const parts: unknown[] = [];

    if (meta?.parts) {
      // New format: ordered parts array — preserves text → tools → text sequence
      const resultMap = new Map<string, StoredPart>();
      const errorMap = new Map<string, string>();
      for (const p of meta.parts) {
        if (p.type === "tool-result") resultMap.set(p.id, p);
        else if (p.type === "tool-error") errorMap.set(p.id, p.error);
      }
      for (const p of meta.parts) {
        if (p.type === "text") {
          if (p.text) parts.push({ type: "text", text: p.text });
        } else if (p.type === "reasoning") {
          if (p.text) parts.push({ type: "reasoning", text: p.text });
        } else if (p.type === "tool-call") {
          const tr = resultMap.get(p.id) as { output?: unknown } | undefined;
          const err = errorMap.get(p.id);
          // A call the runner suspended (no-execute `ask`) for a human answer.
          // awaiting (no value, no result) → input-available; answered → output-
          // available once its tool-result lands. `answer.form`/`answer.value` ride
          // along so the AskCard owns the whole lifecycle — NOT the orphan→error
          // fallback below. (Safe past sealOrphanToolCalls: an answered call is
          // output-available; an unanswered one only reaches the model feed on a
          // fork/abandon, where sealing to an error is the correct behavior.)
          if (p.answer) {
            parts.push({
              type: "dynamic-tool", toolCallId: p.id, toolName: p.name, input: p.input,
              state: tr ? "output-available" : "input-available",
              output: tr?.output,
              askForm: p.answer.form, askValue: p.answer.value,
            });
            continue;
          }
          // A call the SDK suspended for native human-in-the-loop approval. Mapped
          // to the AI SDK 6 approval states so convertToModelMessages rebuilds the
          // exact tool-approval-request/response the resume needs (and the card
          // renders Approve/Reject), NOT the orphan→output-error fallback below.
          // awaiting → approval-requested; decided-but-not-yet-executed OR denied →
          // approval-responded (convert synthesizes an execution-denied result for a
          // denied call); approved AND executed → falls through to output-available
          // once its tool-result lands.
          if (p.approval) {
            const a = p.approval;
            // awaiting → approval-requested; approved-and-executed → output-available
            // (its tool-result landed); approved-not-yet-run OR denied →
            // approval-responded (convertToModelMessages synthesizes an
            // execution-denied result for a denied call). The `approval` marker
            // rides along in every state so the card owns the whole lifecycle.
            const state = a.approved === undefined ? "approval-requested" : tr ? "output-available" : "approval-responded";
            parts.push({
              type: "dynamic-tool", toolCallId: p.id, toolName: p.name, input: p.input, state,
              output: tr?.output, approval: { id: a.id, approved: a.approved, reason: a.reason },
            });
            continue;
          }
          // AI SDK 6 tool-part states: input-streaming | input-available |
          // output-available | output-error. A call with neither result nor
          // error yet is awaiting output — but only LEGITIMATELY so while its
          // turn is still streaming. On a finished turn (status !== "running")
          // an output-less call is an orphan: the turn was interrupted mid-tool
          // (deadline, lost worker, cancel) or this row was COPIED by a fork.
          // Render it as a terminal error, not a forever-spinner — and, just as
          // important, the model's history view (this same mapping) then carries
          // a complete call→result pair, so convertToModelMessages won't throw
          // AI_MissingToolResultsError on the next turn. See sealOrphanToolCalls.
          const isLive = meta?.status === "running";
          const orphan = !tr && !err && !isLive;
          const state = tr ? "output-available" : err || orphan ? "output-error" : "input-available";
          parts.push({
            type: "dynamic-tool",
            toolCallId: p.id,
            toolName: p.name,
            state,
            input: p.input,
            output: tr?.output,
            ...(err ? { errorText: err } : orphan ? { errorText: INTERRUPTED_TOOL_RESULT } : {}),
          });
        }
      }
    } else if (meta?.toolCalls) {
      // Legacy format: flat arrays, tools first then text
      const resultMap = new Map(meta.toolResults?.map((tr) => [tr.id, tr]) ?? []);
      for (const tc of meta.toolCalls) {
        const tr = resultMap.get(tc.id);
        parts.push({
          type: "dynamic-tool",
          toolCallId: tc.id,
          toolName: tc.name,
          state: tr ? "output-available" : "output-error",
          input: tc.input,
          output: tr?.output,
        });
      }
      if (m.content) parts.push({ type: "text", text: m.content });
    } else if (m.content) {
      parts.push({ type: "text", text: m.content });
    }

    return {
      id: m.id,
      role: m.role,
      parts,
      metadata: {
        createdAt: m.createdAt?.toISOString() ?? null,
        platform: m.platform ?? "web",
        taskStatus: meta?.status,
        // How long this turn had ALREADY been running when this snapshot was
        // built. Only meaningful while status:"running": it lets a client that
        // joins a live turn late (tab reopened, reconnect) tick the elapsed clock
        // from the run's real start instead of from its own first paint, which is
        // what made a reopened tab report a few seconds for a turn that had been
        // thinking for a minute. Deliberately a DURATION, not a timestamp: the
        // client subtracts it from its own clock, so a skewed client clock can't
        // become a wrong number on screen.
        runningMs: meta?.status === "running" && m.createdAt ? Date.now() - m.createdAt.getTime() : undefined,
        // Seq the persisted parts cover — lets a client resuming mid-stream
        // reconcile live deltas against this snapshot. See MessageMeta.streamSeq.
        streamSeq: meta?.streamSeq,
        // Forward the failure shape so a failed turn's ErrorNotice shows the real
        // message after a reload (not the generic fallback). message.tsx reads
        // these to pick a localized, role-aware error.
        error: meta?.error,
        errorDetail: meta?.errorDetail,
        errorCategory: meta?.errorCategory,
        errorOwned: meta?.errorOwned,
        parentId: m.parentId ?? null,
        siblingIndex: m.siblingIndex ?? 0,
        siblingCount: m.siblingCount ?? 1,
        // Surfaced so the user bubble can render attachment thumbnails.
        attachedFiles: meta?.attachedFiles,
        // Files the turn changed but never named — the folded second tier under
        // the artifact tiles. The NAMED tier isn't forwarded: it's re-derived from
        // the reply text on render, so it stays correct if the text is edited.
        touchedFiles: meta?.touchedFiles,
        // The resolved [N] → source snapshot written at finalize — how a chip
        // citing a PREVIOUS turn's source still links (this message's own tool
        // parts don't carry that source).
        citedSources: meta?.citedSources,
        // Compaction checkpoint — the transcript renders a divider (not an empty
        // bubble) and lets the user expand the summary it stands in for.
        compaction: meta?.compaction,
        // Tech details for the assistant (i) popover.
        durationMs: meta?.durationMs,
        reasoningMs: meta?.reasoningMs,
        model: meta?.model,
        usage: meta?.usage,
        costUsd: meta?.costUsd,
        costSource: meta?.costSource,
        upstreamProvider: meta?.upstreamProvider,
        // Whether this turn has an OpenRouter generation to pull latency + the
        // provider chain from. The raw gen id stays server-side (the popover hits
        // /api/messages/[id]/generation, which resolves it); the client only needs
        // to know the affordance exists.
        hasGeneration: meta?.generationId ? true : undefined,
        contextWindow: meta?.contextWindow,
        contextTokens: meta?.contextTokens,
        // What this turn saved to memory, if anything. `undefined` and not `[]` when it
        // saved nothing: the notice's own rule is that it says nothing at all, and an
        // empty array is a value a renderer can accidentally treat as "render the frame
        // with no rows in it".
        memoryWrites: memoryWrites[m.id]?.length ? memoryWrites[m.id] : undefined,
      },
    };
  });
}
