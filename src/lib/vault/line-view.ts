/**
 * A BODY AS NUMBERED LINES, PAGED — an import-free leaf, for the same reason
 * `note-title.ts` and `memory-sections.ts` are ones.
 *
 * It lives on its own because its two callers must not import each other.
 * `read-tools.ts` shows the model a note this way, and that module deliberately contains no
 * database import at all (§3.4 NEW-3: `memory_open` mints, it never reads a row). The
 * writer's edit reply shows a snippet in the same format, and it lives in `write-tools.ts`,
 * which is nothing but database. A shared helper in either of them would drag one file's
 * dependencies into the other.
 *
 * WHY NUMBERED AT ALL. `insert_line` addresses a line, and `str_replace`'s duplicate
 * refusal names the lines an ambiguous match sits on. A model that has to count lines
 * itself gets that wrong; a model reading `cat -n` output does not, and it is the format
 * Claude's own file tools already show it. So the numbers are not decoration — they are the
 * addresses the edit tools take.
 *
 * The numbering is over the RENDERED body (edge tokens shown as `[[Title]]`), which is the
 * same text the edits are matched against. Substitution never adds or removes a newline —
 * a title is clamped to one line and the removed-link text has none — so a line number is
 * the same on both sides of it, and the writer can compute lines against the STORED body.
 */

/** `cat -n`'s own column: six right-aligned digits, then a tab. */
export const numberLine = (n: number, text: string): string => `${String(n).padStart(6)}\t${text}`;

export type LinePage = {
  /** The numbered page, lines joined by newlines. */
  text: string;
  /** Where the next page starts, or `null` when this one is the last. `"<line>"` at a line
   *  boundary and `"<line>.<byte>"` when a single line was too long for one page — opaque
   *  to the model either way, and refused rather than repaired when it is not one this
   *  function handed out. */
  next: string | null;
  /** The 1-based line numbers this page covers, and the file's total. `0`/`0`/`0` for an
   *  empty body: a file with no lines has no first line to name. */
  from: number;
  to: number;
  total: number;
};

const CURSOR_RE = /^([0-9]{1,10})(?:\.([0-9]{1,10}))?$/;

/** Whether a byte offset lands inside a UTF-8 sequence rather than on a character. */
const midSequence = (buf: Buffer, at: number) => at < buf.length && (buf[at] & 0xc0) === 0x80;

/**
 * ONE PAGE, cut on a LINE boundary inside a byte budget, and on a CHARACTER boundary when a
 * single line will not fit in one.
 *
 * BYTES, because the turn budget is bytes (`MEMORY_OPEN_MAX_BYTES`) and a character count
 * would grant a Cyrillic turn twice the context an English one gets. The line prefixes count
 * against the budget too: they are bytes the model receives.
 *
 * A LINE TOO LONG FOR A PAGE keeps its number on the continuation, which is what makes the
 * numbering answerable at all — a second number for the same line would be an address that
 * addresses nothing, and renumbering the tail would make every later line disagree with the
 * file. This is the one place a page's text is not a whole line, and the cursor's `.byte`
 * half exists for exactly it.
 *
 * `null` for a cursor this function did not hand out — a malformed one, a line past the
 * end, or a byte offset inside a character. §4.1's answer to a fabricated address is never
 * "guess".
 */
export function pageLines(body: string, cursor: string | undefined, maxBytes: number): LinePage | null {
  // A floor, so the loop below always makes progress: a budget under one prefix plus one
  // character has no page to emit and no cursor to advance, and every caller's real budget
  // is three orders of magnitude above this.
  const budget = Math.max(maxBytes, 16);
  const lines = body === "" ? [] : body.split("\n");
  if (!lines.length) {
    return cursor === undefined ? { text: "", next: null, from: 0, to: 0, total: 0 } : null;
  }

  let line = 0;
  let byte = 0;
  if (cursor !== undefined) {
    const m = CURSOR_RE.exec(cursor);
    if (!m) return null;
    line = Number(m[1]);
    byte = m[2] === undefined ? 0 : Number(m[2]);
    if (line >= lines.length) return null;
    const buf = Buffer.from(lines[line], "utf8");
    // Past the line's end, or exactly at it with a resume offset: both are addresses this
    // function never emits, because a page that consumed a whole line moves to the next one.
    if (byte >= buf.length && byte !== 0) return null;
    if (midSequence(buf, byte)) return null;
  }

  const from = line + 1;
  const parts: string[] = [];
  let spent = 0;
  let to = line + 1;
  let next: string | null = null;

  while (line < lines.length) {
    const rest = Buffer.from(lines[line], "utf8").subarray(byte);
    const prefix = numberLine(line + 1, "");
    // The newline that will join this piece to the previous one is a byte the model gets.
    const overhead = (parts.length ? 1 : 0) + Buffer.byteLength(prefix, "utf8");
    const room = budget - spent - overhead;

    if (rest.length <= room) {
      parts.push(prefix + rest.toString("utf8"));
      spent += overhead + rest.length;
      to = line + 1;
      line += 1;
      byte = 0;
      continue;
    }

    // A LINE IS CUT ONLY WHEN IT ALONE WILL NOT FIT IN A WHOLE PAGE. With something already
    // on this page, the honest end is the line boundary — splitting a line because thirty
    // bytes were left would scatter one sentence across pages for no gain, and the model
    // would have to reassemble it before it could match anything against it.
    if (parts.length) {
      next = byte === 0 ? String(line) : `${line}.${byte}`;
      break;
    }
    let end = Math.max(room, 0);
    while (end > 0 && midSequence(rest, end)) end -= 1;
    if (end === 0 && rest.length > 0) {
      // A budget smaller than one character of the first line. Emitting an empty page would
      // hand back a cursor identical to the one that produced it, which is a loop; one
      // character over budget is the honest way out and cannot recur.
      end = 1;
      while (end < rest.length && midSequence(rest, end)) end += 1;
    }
    if (end === 0) {
      next = byte === 0 ? String(line) : `${line}.${byte}`;
      break;
    }
    parts.push(prefix + rest.subarray(0, end).toString("utf8"));
    to = line + 1;
    next = `${line}.${byte + end}`;
    break;
  }
  if (next === null && line < lines.length) next = byte === 0 ? String(line) : `${line}.${byte}`;

  return { text: parts.join("\n"), next, from, to, total: lines.length };
}
