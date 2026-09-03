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
  /** Where the next page starts, or `null` when this one is the last. `"l<line>"` at a line
   *  boundary and `"l<line>.<byte>"` when a single line was too long for one page — the line
   *  is the 1-based number the page will DISPLAY, and the `l` is what keeps the value from
   *  being mistaken for one.
   *
   *  THE PREFIX IS THE POINT. Without it a cursor is an integer that looks exactly like a
   *  line number the model can see on screen, and a fabricated one that happens to be a valid
   *  index cannot be refused — the reader silently returns a page starting somewhere the
   *  model chose rather than somewhere this function offered. With it, anything the model
   *  composes itself is a `bad_cursor`, which is what the docstring below already promises. */
  next: string | null;
  /** The 1-based line numbers this page covers, and the file's total. `0`/`0`/`0` for an
   *  empty body: a file with no lines has no first line to name. */
  from: number;
  to: number;
  total: number;
};

/** The wire form of a position: the 1-based line the next page opens on, prefixed so it can
 *  never be read as a bare line number, plus the byte offset when a page stopped mid-line. */
const cursorAt = (line: number, byte: number) => (byte === 0 ? `l${line + 1}` : `l${line + 1}.${byte}`);

const CURSOR_RE = /^l([0-9]{1,10})(?:\.([0-9]{1,10}))?$/;

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
    // 1-BASED ON THE WIRE, 0-based inside: the number in a cursor is the number the next
    // page's first line will be printed with, so a person reading a transcript can line the
    // two up. Line 0 is not a line, and neither is a cursor naming it.
    line = Number(m[1]) - 1;
    byte = m[2] === undefined ? 0 : Number(m[2]);
    if (line < 0 || line >= lines.length) return null;
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
      next = cursorAt(line, byte);
      break;
    }
    // `room` is at least 9 here: this is the page's first piece (no joining newline), the
    // prefix is at most 11 bytes for any line count a note can reach, and the budget is
    // floored at 16 above. A UTF-8 sequence is at most 4 bytes, so backing off a cut that
    // landed mid-character always leaves at least one whole character — the page is never
    // empty, and the cursor it hands back is always ahead of the one that produced it.
    let end = room;
    while (midSequence(rest, end)) end -= 1;
    parts.push(prefix + rest.subarray(0, end).toString("utf8"));
    to = line + 1;
    next = cursorAt(line, byte + end);
    break;
  }
  if (next === null && line < lines.length) next = cursorAt(line, byte);

  return { text: parts.join("\n"), next, from, to, total: lines.length };
}
