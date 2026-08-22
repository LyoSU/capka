/**
 * Cap a tool's text output before it reaches the model.
 *
 * A single unbounded result — a 5 MB log, `cat huge.json`, a chatty installer —
 * is the worst thing a tool can hand the model: it is persisted to Postgres and
 * re-sent every turn (real $ on a real-cost platform), it drowns the useful
 * signal, and one oversized result can trip the reactive `context_too_long` path
 * that mechanically drops recent conversation. Capka's compaction trims OLD
 * history; nothing capped a FRESH result at the moment it was produced. This does.
 *
 * The marker is deliberate: it sits AT the cut (not merely appended), states that
 * the gap is a truncation and NOT the program's real output, and tells the model
 * how to get the rest — so next time it narrows instead of guessing.
 *
 * Both the sandbox tools and the MCP adapter route their text through here, so a
 * chatty connector is bounded the same way a chatty shell command is.
 */

/** Per-call output budget (characters ≈ the cost knob — chars map to tokens).
 *  Operators tune it without a redeploy. Exported so the capture-to-file path can
 *  use the same threshold to decide a result is small enough to skip the log file. */
export const MAX_TOOL_OUTPUT_CHARS = Number(process.env.MAX_TOOL_OUTPUT_CHARS) || 30_000;
/** Default line budget for file reads (mirrors Claude Code's 2000-line Read). */
export const DEFAULT_READ_LINES = Number(process.env.MAX_TOOL_OUTPUT_LINES) || 1500;

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

export interface ClampResult {
  text: string;
  /** Did we cut anything? Surfaced to the model as a structured signal too. */
  clipped: boolean;
}

/** Keep a head slice + a tail slice, drop the middle. Snap each cut back to a
 *  line boundary when one is reasonably close, so we never sever a line mid-token. */
function clipMiddle(text: string, maxChars: number, marker: string): string {
  const headLen = Math.floor(maxChars * 0.65);
  const tailLen = Math.floor(maxChars * 0.25);

  let head = text.slice(0, headLen);
  const nlHead = head.lastIndexOf("\n");
  if (nlHead > headLen * 0.5) head = head.slice(0, nlHead);

  let tail = text.slice(text.length - tailLen);
  const nlTail = tail.indexOf("\n");
  if (nlTail !== -1 && nlTail < tailLen * 0.5) tail = tail.slice(nlTail + 1);

  return head + marker + tail;
}

/**
 * Clamp `text` to the output budget.
 *  - `clip` (default): head + tail with the middle removed — for command output
 *    and chatty tools, where the head has context and the tail has the result/error.
 *  - `head`: first lines only — for file reads, where a "continue from line N" hint
 *    is the natural way to get more.
 * `note` is appended inside the marker as the recovery instruction for the model.
 */
export function clampOutput(
  text: string,
  opts: { mode?: "clip" | "head"; maxChars?: number; maxLines?: number; note?: string } = {},
): ClampResult {
  const { mode = "clip", maxChars = MAX_TOOL_OUTPUT_CHARS, maxLines = DEFAULT_READ_LINES, note } = opts;
  const hint = note ? ` ${note}` : "";

  if (mode === "head") {
    const lines = text.split("\n");
    let kept = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : text;
    let clipped = lines.length > maxLines;
    if (kept.length > maxChars) {
      kept = kept.slice(0, maxChars);
      clipped = true;
    }
    if (!clipped) return { text, clipped: false };
    const shown = kept.split("\n").length;
    const marker = `\n[… Capka: showing the first ${shown} of ${lines.length} lines — display limit, not the end of the data.${hint}]`;
    return { text: kept + marker, clipped: true };
  }

  if (text.length <= maxChars) return { text, clipped: false };
  const marker = `\n\n[… Capka: OUTPUT TRUNCATED — middle omitted (~${kb(text.length)} total). This is NOT the program's real output here.${hint} …]\n\n`;
  return { text: clipMiddle(text, maxChars, marker), clipped: true };
}

/**
 * Total tool output one turn may produce, in characters. `MAX_TOOL_OUTPUT_CHARS`
 * bounds a single call; nothing bounded the sum, so a turn making hundreds of calls
 * had no ceiling at all — at the step cap that is over half a million characters of
 * fresh context, re-sent on every subsequent step.
 *
 * Unlike the mid-turn brake this holds unconditionally: it needs no reported usage,
 * no estimate, and no server-side edit, which is exactly why both exist.
 *
 * ENFORCED BY STOPPING, not by rewriting: once a turn's results add up past this,
 * `prepareStep` sets `toolChoice: "none"` and the model answers with what it has.
 * The first cut wrapped every tool's `execute` and refused the call past the
 * ceiling, which was the wrong layer four different ways — it broke tools returning
 * an async iterable (the SDK inspects the IMMEDIATE return value, and an async
 * wrapper hands it a promise), it could not reserve budget safely when the SDK runs
 * a batch of calls concurrently, its plain-string refusal went through each tool's
 * own `toModelOutput` and came out of the MCP converter as an empty result, and the
 * refusal was recorded in the effect ledger as a call that RAN. Forcing text has
 * none of those: nothing is refused, nothing is rewritten, and it reuses the path
 * FORCE_TEXT_AFTER_STEPS already proves.
 */
/**
 * Serialized size of a tool's output, in characters — the unit both output budgets
 * are denominated in. One place, because a size that is measured two slightly
 * different ways is two different budgets.
 *
 * A non-serializable value (a cycle, a BigInt) counts as zero: the call still
 * happened, but guessing high would spend a budget on an artifact of the encoding.
 */
export function outputChars(v: unknown): number {
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

export const MAX_TURN_TOOL_OUTPUT_CHARS = Number(process.env.MAX_TURN_TOOL_OUTPUT_CHARS) || 400_000;

