import type { MessageMeta } from "@/lib/chat/contracts";
import { applyCompaction, type CtxMessage } from "./compaction";
import { clearStaleToolResults } from "./tool-clearing";

/**
 * The DB-row shape `toUIMessages` consumes. `buildModelContext` takes the active
 * path in this shape and returns it in the same shape, so the runner can pipe it
 * straight into `toUIMessages` → `convertToModelMessages` with no other changes.
 */
export interface ContextRow {
  id: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: Date | null;
  platform: string | null;
  parentId?: string | null;
  siblingIndex?: number;
  siblingCount?: number;
}

/**
 * Emergency mechanical trim for the reactive `context_too_long` path: keep only
 * the most recent `keepRecent` messages, then drop any leading non-user turns so
 * the trimmed conversation still starts on a user message (some providers reject
 * a leading assistant turn). No LLM involved — used precisely when the prefix is
 * already too big to summarize. Returns the input untouched when it's already
 * within the limit.
 */
export function trimToRecent<T extends { role: string }>(rows: T[], keepRecent: number): T[] {
  if (rows.length <= keepRecent) return rows;
  const tail = rows.slice(-keepRecent);
  let start = 0;
  while (start < tail.length && tail[start].role !== "user") start++;
  return tail.slice(start);
}

export interface BuildOptions {
  /** When set, clear tool-result bodies older than this many (global) results.
   *  Omit to leave tool results intact (the cache-friendly default between
   *  compaction events). */
  clearToolsKeepLast?: number;
}

/**
 * Shape the active path into what we actually feed the model:
 *   1. collapse history at the newest compaction checkpoint into a summary, then
 *   2. (optionally) clear stale tool-result bodies in the surviving tail.
 *
 * Both steps run ONLY at a compaction event (the runner passes
 * `clearToolsKeepLast` only then), never per turn — so between events the prefix
 * is byte-stable and the prompt cache keeps hitting. The DB and the UI transcript
 * keep the full history regardless; this only trims the model's view.
 */
export function buildModelContext(rows: ContextRow[], opts: BuildOptions): ContextRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Lift the per-row metadata the shaping functions need to the top level.
  const ctx: CtxMessage[] = rows.map((r) => {
    const meta = r.metadata as MessageMeta | null;
    return {
      id: r.id,
      role: r.role,
      parts: meta?.parts,
      compaction: meta?.compaction,
    };
  });

  let shaped = applyCompaction(ctx);
  if (opts.clearToolsKeepLast !== undefined) {
    shaped = clearStaleToolResults(shaped, opts.clearToolsKeepLast);
  }

  // Lower back to DB rows. A surviving message reuses its original row (with
  // possibly-cleared parts merged back into metadata); the synthetic summary
  // message has no original, so we mint a fresh row for it.
  return shaped.map((m): ContextRow => {
    const orig = byId.get(m.id);
    if (orig && m.role === orig.role) {
      const meta = (orig.metadata ?? {}) as MessageMeta;
      return { ...orig, metadata: { ...meta, parts: m.parts } };
    }
    // Synthetic summary message (its role was rewritten to "user").
    return {
      id: m.id,
      role: m.role,
      content: "",
      metadata: { parts: m.parts } satisfies Pick<MessageMeta, "parts">,
      createdAt: orig?.createdAt ?? null,
      platform: orig?.platform ?? "web",
    };
  });
}
