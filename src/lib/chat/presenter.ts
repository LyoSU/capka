import type { StoredPart, MessageMeta } from "./contracts";
import { INTERRUPTED_TOOL_RESULT } from "./tool-results";

/** Convert DB message rows to UI message format */
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
}[]) {
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
        // Seq the persisted parts cover — lets a client resuming mid-stream
        // reconcile live deltas against this snapshot. See MessageMeta.streamSeq.
        streamSeq: meta?.streamSeq,
        // Forward the failure shape so a failed turn's ErrorNotice shows the real
        // message after a reload (not the generic fallback). message.tsx reads
        // these to pick a localized, role-aware error.
        error: meta?.error,
        errorDetail: meta?.errorDetail,
        errorCategory: meta?.errorCategory,
        parentId: m.parentId ?? null,
        siblingIndex: m.siblingIndex ?? 0,
        siblingCount: m.siblingCount ?? 1,
        // Surfaced so the user bubble can render attachment thumbnails.
        attachedFiles: meta?.attachedFiles,
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
      },
    };
  });
}
