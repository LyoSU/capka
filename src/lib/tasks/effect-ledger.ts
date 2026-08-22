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

import type { StoredPart } from "@/lib/chat/contracts";

/** One executed tool call. Recorded when its result — or its error — arrives, so
 *  it means "this ran", not "this was requested". */
export interface TurnEffect {
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
    const call = calls.get(p.id);
    out.push({
      name: call?.name ?? p.name,
      input: call?.input,
      ...(p.type === "tool-error" ? { failed: true } : {}),
    });
  }
  return out;
}
