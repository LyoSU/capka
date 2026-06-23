import type { StoredPart, MessageMeta } from "./contracts";

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
          // AI SDK 6 tool-part states: input-streaming | input-available |
          // output-available | output-error. A call with neither result nor
          // error yet has its input available and is awaiting output.
          const state = tr ? "output-available" : err ? "output-error" : "input-available";
          parts.push({
            type: "dynamic-tool",
            toolCallId: p.id,
            toolName: p.name,
            state,
            input: p.input,
            output: tr?.output,
            ...(err ? { errorText: err } : {}),
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
        // Capability heads-up (e.g. audio sent to a text-only model) — drives the
        // "switch model" nudge on the turn.
        notice: meta?.notice,
        // Tech details for the assistant (i) popover.
        durationMs: meta?.durationMs,
        reasoningMs: meta?.reasoningMs,
        model: meta?.model,
        usage: meta?.usage,
        costUsd: meta?.costUsd,
      },
    };
  });
}
