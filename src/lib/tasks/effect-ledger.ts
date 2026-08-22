/**
 * What this turn has ALREADY DONE, in a form that survives a restart of the turn.
 *
 * The emergency context-overflow path re-streams the turn from a mechanically
 * trimmed history (`trimToRecent`), and everything the turn had done so far lived
 * only in the discarded stream: `discardPartial` empties `parts`, and the trimmed
 * history is settled turns, which by definition don't contain the in-flight one.
 * So the restarted model came back with no idea that ninety products were already
 * in the catalogue. It never LOST a write — it lost the record of writes whose
 * effects are live, which is the worse half: the next thing it does is repeat
 * them, and an upload or a create is not idempotent.
 *
 * A ledger, not a rollback: we cannot undo someone else's catalogue. What we can
 * do is tell the model what it already did, which is also the only thing it needs
 * to avoid doing it twice.
 */

/** One executed tool call. Recorded when its result arrives, so it means "this
 *  ran", not "this was requested". */
export interface TurnEffect {
  name: string;
  input: unknown;
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
  "This turn ran out of context and was restarted, so the transcript above is " +
  "incomplete. The tool calls listed below ALREADY RAN in this same turn and " +
  "their effects are live. Do NOT repeat them. Continue from where they stopped, " +
  "and if you are unsure whether a specific item landed, check it before writing " +
  "it again.\n";

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

  const itemized = HEADER + effects.map((e) => `- ${e.name} ${renderArgs(e.input)}`.trimEnd()).join("\n");
  if (itemized.length <= RECOVERY_NOTE_BUDGET) return itemized;

  const counts = new Map<string, number>();
  for (const e of effects) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const summary = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `- ${name} ×${n}`)
    .join("\n");
  return `${HEADER}(too many to list individually — counts only)\n${summary}`;
}
