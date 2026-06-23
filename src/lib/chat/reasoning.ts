/** Some reasoning-capable models leak their chain-of-thought delimiters into the
 *  reasoning stream itself — a literal `<think>`/`<thinking>`/`<reasoning>`
 *  wrapper, usually trailed by a blank line or two. Those tags are framing, not
 *  thought, so for *display* we strip the tags (keeping their inner text) and
 *  trim the leading break / trailing whitespace they leave behind. The DB keeps
 *  the raw reasoning; this only cleans what the user reads.
 *
 *  Deliberately conservative: only the known wrapper tags are removed, so a real
 *  `<div>` or `a < b` inside a thought survives untouched. Mirrors the tag set in
 *  `title.ts`, which strips the same wrappers (there, content and all). */
export function cleanReasoning(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/<\/?(?:think|thinking|reasoning)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
}
