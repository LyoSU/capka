/**
 * A user's message is typed, not authored: one Enter means "new line", the way
 * every chat app reads it, not the paragraph-joining soft break Markdown gives
 * it. Turn each single newline outside a code fence into a hard break (two
 * trailing spaces) so the bubble keeps the person's line structure while the
 * rest of their Markdown (lists, bold, links, fences) renders as written.
 * Blank-line paragraph breaks and fence bodies are left exactly as typed.
 */
export function withHardBreaks(text: string): string {
  return text
    .split(/(^|\n)(```[\s\S]*?(?:\n```|$))/)
    .map((chunk, i) =>
      // The split keeps its capture groups: from index 1 on, every third element is
      // the newline that led into a fence and the one after it the fence itself
      // (opening line through closing line). Only the prose chunks (index 0 mod 3)
      // get the break treatment; the newline that opens a prose chunk is the closing
      // fence's own line end, and a fence interrupts a paragraph by itself, so
      // neither edge needs a break.
      i % 3 === 0 ? chunk.replace(/(?<!^|\n)\n(?!\n)/g, "  \n") : chunk,
    )
    .join("");
}
