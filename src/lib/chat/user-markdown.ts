/**
 * A user's message is typed, not authored: one Enter means "new line", the way
 * every chat app reads it, not the paragraph-joining soft break Markdown gives
 * it. Turn each single newline outside a code fence into a hard break (two
 * trailing spaces) so the bubble keeps the person's line structure while the
 * rest of their Markdown (lists, bold, links, fences) renders as written.
 * Blank-line paragraph breaks and fence bodies are left exactly as typed.
 */

/** An opening or closing fence line: up to three spaces of indent, then a run of
 *  three or more backticks or tildes (CommonMark). Both markers matter — the
 *  renderer accepts either, so guarding only backticks put two trailing spaces
 *  inside a `~~~` block and the copied code stopped matching what was typed. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function withHardBreaks(text: string): string {
  const lines = text.split("\n");
  // Which lines belong to a fenced block (its delimiters included) — they are
  // passed through untouched, and so is the prose line that opens one.
  const fenced: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (open === null) {
      // A backtick fence's info string may not contain a backtick, which is what
      // keeps inline code like ```a``b`` from opening a block. Tildes may.
      const opens = !!m && (m[1][0] === "~" || !line.slice(m[0].length).includes("`"));
      fenced.push(opens);
      if (opens) open = m![1];
      continue;
    }
    fenced.push(true);
    // Closes only on the SAME marker, at least as long as the opener, followed by
    // spaces or tabs and nothing else — so ``` inside a ~~~ block stays content.
    // `.trim()` was too generous here: it also strips Unicode spaces, so a fence run
    // followed by a no-break space (U+00A0) closed the block for us while the
    // renderer kept it open, and every code line after it picked up trailing spaces
    // the person never typed.
    if (m && m[1][0] === open[0] && m[1].length >= open.length && /^[ \t]*$/.test(line.slice(m[0].length))) open = null;
  }
  return lines
    .map((line, i) => {
      const next = lines[i + 1];
      // A hard break belongs on a non-empty prose line that another prose line
      // follows. Not before a blank line (that is a paragraph break the person
      // typed), not at the end of the message, and never around a fence.
      const soft = !fenced[i] && !fenced[i + 1] && line !== "" && next !== undefined && next !== "";
      return soft ? `${line}  ` : line;
    })
    .join("\n");
}
