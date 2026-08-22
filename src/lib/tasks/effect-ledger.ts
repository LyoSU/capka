/**
 * What this turn has ALREADY DONE, in a form that survives a restart of the turn.
 *
 * Every restart path re-streams from history that cannot contain the in-flight
 * turn: `discardPartial` empties `parts`, and the historical messages are settled
 * turns by definition. So the restarted model came back with no idea that ninety
 * products were already in the catalogue. It never LOST a write — it lost the
 * record of writes whose effects are live, which is the worse half: the next thing
 * it does is repeat them, and an upload or a create is not idempotent.
 *
 * The context overflow is the LOUDEST of those paths, not the only one. The
 * capability retries (an unsupported modality, a rejected reasoning effort,
 * reasoning that can't be echoed back) restart the same way, and the echoed-
 * reasoning rejection is definitionally a step-1+ event — there is no prior
 * reasoning to echo on step 0 — so it fires precisely when a tool call has already
 * run. Hence the note's wording names no cause: it is the same statement of fact
 * whichever restart produced it.
 *
 * A ledger, not a rollback: we cannot undo someone else's catalogue. What we can
 * do is tell the model what it already did, which is also the only thing it needs
 * to avoid doing it twice.
 */

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEffects } from "@/lib/db/schema";
import { stripNul } from "@/lib/tasks/sanitize";
import type { StoredPart } from "@/lib/chat/contracts";

/** One executed tool call. Recorded when its result — or its error — arrives, so
 *  it means "this ran", not "this was requested". */
export interface TurnEffect {
  /** The SDK's tool-call id. Present on both sources so the two can be merged
   *  without counting one call twice. */
  id?: string;
  name: string;
  input: unknown;
  /** The call threw instead of returning. It still RAN, and a tool that writes
   *  before it fails has already written, so this is the entry the model most
   *  needs: "did this land?" is unanswerable from here and must be checked. */
  failed?: boolean;
}

/** Per-entry cap for the rendered arguments. Enough to identify a row (an sku, a
 *  path, an id) and nowhere near enough to replay a payload — the note exists to
 *  prevent repeated work, not to carry the work forward. */
export const EFFECT_ARG_CHARS = 100;

/**
 * Char budget for the whole note. The note rides in the prompt of a retry that
 * just died of an oversized prompt, so an unbounded list would re-create the very
 * failure it exists to recover from. Past the budget the note degrades to per-tool
 * counts, which still answers the question that matters ("did I already write
 * these?") in a bounded number of tokens.
 */
export const RECOVERY_NOTE_BUDGET = 6000;

const HEADER =
  "[Recovery note — read before acting]\n" +
  "This turn was restarted part-way through, so the transcript above no longer " +
  "shows everything that happened in it. The tool calls listed below ALREADY RAN " +
  "in this same turn and their effects are live. Do NOT repeat them. Continue from " +
  "where they stopped, and if you are unsure whether a specific item landed, check " +
  "it before writing it again.\n";

/** Compact one call's arguments to something identifying. */
function renderArgs(input: unknown): string {
  // No arguments to identify the call by. Both sources produce this — `parts` has
  // no `tool-call` to pair with, the table stores SQL NULL for a no-argument call —
  // and `JSON.stringify(null)` is the string "null", which would put a line reading
  // `- wp_publish_product null` into a prompt that just died of size.
  if (input === null || input === undefined) return "";
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  } catch {
    // A tool can hand back something non-serializable (a cycle, a BigInt). The
    // call still ran, so it belongs in the note — just without its arguments.
    return "";
  }
  return s.length > EFFECT_ARG_CHARS ? `${s.slice(0, EFFECT_ARG_CHARS)}…` : s;
}

/**
 * Render the ledger for injection into a restarted turn, or null when there is
 * nothing to warn about.
 *
 * Two shapes, chosen by size: the itemized list while it fits (best — the model
 * can see exactly which sku or path is done), per-tool counts once it doesn't
 * (still actionable — "98 upserts already ran" is enough to make it verify rather
 * than redo). Counting is over ALL entries in both shapes; nothing is silently
 * dropped, because an omitted entry is precisely the one that gets done twice.
 */
export function buildRecoveryNote(effects: TurnEffect[]): string | null {
  if (effects.length === 0) return null;

  const itemized =
    HEADER +
    effects
      .map((e) => `- ${e.name} ${renderArgs(e.input)}${e.failed ? " [errored — may or may not have taken effect; verify]" : ""}`.replace(/  +/g, " ").trimEnd())
      .join("\n");
  if (itemized.length <= RECOVERY_NOTE_BUDGET) return itemized;

  const counts = new Map<string, { ran: number; failed: number }>();
  for (const e of effects) {
    const c = counts.get(e.name) ?? { ran: 0, failed: 0 };
    c.ran++;
    if (e.failed) c.failed++;
    counts.set(e.name, c);
  }
  // Bounded, not just shorter. One line per distinct tool name is only small while
  // the tool COUNT is — a few busy MCP connectors put hundreds in reach, and this
  // note rides in the prompt of a retry that just died of an oversized one. So the
  // budget gates the RESULT here too, with the rarest tools collapsing into a
  // remainder line rather than being dropped: a tool the model can't see is the one
  // it runs again.
  const ordered = [...counts].sort((a, b) => b[1].ran - a[1].ran);
  const lead = `${HEADER}(too many to list individually — counts only)\n`;
  const lines: string[] = [];
  let used = lead.length;
  let restTools = 0;
  let restCalls = 0;
  for (const [name, c] of ordered) {
    const line = `- ${name} ×${c.ran}${c.failed ? ` (${c.failed} errored — verify those)` : ""}`;
    // Leave room for the remainder line itself, or a long tail would push the note
    // over the budget in the act of admitting it has one.
    if (lines.length > 0 && used + line.length + 60 > RECOVERY_NOTE_BUDGET) {
      restTools++;
      restCalls += c.ran;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (restTools > 0) lines.push(`- …and ${restTools} more tools, ${restCalls} calls — verify before rerunning any of them`);
  return lead + lines.join("\n");
}

/**
 * Rebuild the ledger from a reply's persisted parts.
 *
 * The in-memory ledger is only as durable as the process holding it, and a turn in
 * this system is a durably queued row that can be picked up again — an approval or
 * `ask` continuation is literally a SECOND task writing the SAME message row. Its
 * first half's tool calls are in the row, not in this process's memory, so without
 * this the continuation starts with an empty ledger and the recovery note it might
 * later need would omit everything the first half did.
 *
 * Paired by tool-call id, because the arguments live on the CALL and the evidence
 * that it ran lives on the result (or the error): a `tool-call` with neither is
 * still in flight — or was suspended for approval and never executed — and must
 * not be reported as done.
 */
export function effectsFromParts(parts: StoredPart[]): TurnEffect[] {
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const p of parts) {
    if (p.type === "tool-call") calls.set(p.id, { name: p.name, input: p.input });
  }
  const out: TurnEffect[] = [];
  for (const p of parts) {
    if (p.type !== "tool-result" && p.type !== "tool-error") continue;
    // The SDK rejected this call before running it (unparseable arguments, unknown
    // tool) and synthesized the error itself, so it is not evidence that anything
    // happened. The live ledger already skips these and `recordEffect` is never
    // called for them — but this path is what a CONTINUATION reads, and mergeEffects
    // keeps a parts-only entry precisely because the table has no row for it. So
    // without this the restarted half is told "this already ran, do not repeat"
    // about work that never ran, and the row goes silently unwritten: the omission
    // that is worse than the duplication this module exists to prevent. Fourth
    // reader of one fact — see producedWork and PRODUCED_WORK_SQL for the others.
    if (p.type === "tool-error" && p.invalid) continue;
    const call = calls.get(p.id);
    out.push({
      id: p.id,
      name: call?.name ?? p.name,
      input: call?.input,
      ...(p.type === "tool-error" ? { failed: true } : {}),
    });
  }
  return out;
}

/**
 * A ledger write that did not land after its retries.
 *
 * A distinct type because the alternative is worse than failing: a Postgres blip
 * reads as `network` to `isTransientError`, so the stream loop would treat it as a
 * provider hiccup, re-stream, and carry on with the call unrecorded — losing
 * exactly the durability this module exists to provide. The runner checks for this
 * before its transient classification, so the turn fails closed instead.
 */
export class EffectLedgerError extends Error {}

/** A blip should cost a moment, not a turn; a dead database should fail the turn. */
const LEDGER_WRITE_ATTEMPTS = 3;

/**
 * Record one executed call, durably, against the reply it belongs to.
 *
 * Called on the result or the error — never on the request — so a row means "this
 * ran". Awaited rather than fired off, because the whole point is that the record
 * outlives the process: a restart that begins before the write lands is a restart
 * that starts blind, which is the failure this exists to prevent.
 *
 * Upsert, not insert: an approved call re-runs under the SAME tool-call id, and
 * its second outcome should replace the first rather than appear twice in a note
 * whose only job is to say what happened once.
 */
export async function recordEffect(e: {
  messageId: string;
  toolCallId: string;
  taskId: string;
  name: string;
  input: unknown;
  failed?: boolean;
}): Promise<void> {
  // Sanitized HERE, not at the call sites: a model can emit a literal NUL escape
  // inside a valid JSON string argument, Postgres rejects it in jsonb, and a caller
  // that forgets would turn "this call ran" into a failed write. One place cannot
  // be forgotten in the next one.
  const row = { toolName: e.name, input: stripNul(e.input) ?? null, failed: e.failed ?? false };
  let last: unknown;
  for (let attempt = 1; attempt <= LEDGER_WRITE_ATTEMPTS; attempt++) {
    try {
      await db.insert(messageEffects)
        .values({ messageId: e.messageId, toolCallId: e.toolCallId, producerTaskId: e.taskId, ...row })
        .onConflictDoUpdate({
          target: [messageEffects.messageId, messageEffects.toolCallId],
          // `failed` is sticky: "it threw" is the conservative reading, because a tool
          // that writes before it fails has already written. A later success under the
          // same id must not erase the one entry the note most needs to flag.
          set: { ...row, failed: sql`${messageEffects.failed} or excluded.failed` },
        });
      return;
    } catch (err) {
      last = err;
      if (attempt < LEDGER_WRITE_ATTEMPTS) await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
  throw new EffectLedgerError(`could not record executed tool call ${e.toolCallId}: ${String(last)}`);
}

/**
 * The ledger for one reply, oldest first.
 *
 * Ordered by `created_at` then tool-call id: `now()` is transaction time, so two
 * calls recorded inside one transaction would tie, and a note that reorders itself
 * between reads is a note nobody can diff. Chronology is what the model reads
 * ("continue from where they stopped"), so the tie-break exists to make the order
 * total, not to be meaningful on its own.
 */
export async function loadEffects(messageId: string): Promise<TurnEffect[]> {
  const rows = await db
    .select({ id: messageEffects.toolCallId, name: messageEffects.toolName, input: messageEffects.input, failed: messageEffects.failed })
    .from(messageEffects)
    .where(eq(messageEffects.messageId, messageId))
    .orderBy(asc(messageEffects.createdAt), asc(messageEffects.toolCallId));
  return rows.map((r) => ({ id: r.id, name: r.name, input: r.input, ...(r.failed ? { failed: true } : {}) }));
}


/**
 * Union the durable ledger with what could be rebuilt from `parts`, ledger winning.
 *
 * Not either/or, which was the first cut and was wrong: during a rolling upgrade one
 * message can hold effects in BOTH places — the half that ran before this table
 * existed is only in `parts`, the half after it only in the ledger — and an empty
 * ledger is also what a failed write leaves behind. Preferring one source silently
 * drops the other, and a dropped effect is precisely the one that gets done twice.
 *
 * Parts-only entries come first: an effect the ledger has never heard of predates
 * the ledger for this message, so that order is also the chronological one.
 */
export function mergeEffects(ledger: TurnEffect[], fromParts: TurnEffect[]): TurnEffect[] {
  const known = new Set(ledger.map((e) => e.id).filter((id): id is string => !!id));
  return [...fromParts.filter((e) => !e.id || !known.has(e.id)), ...ledger];
}
