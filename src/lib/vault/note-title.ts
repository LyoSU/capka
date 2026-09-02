/**
 * A NOTE TITLE'S BOUND AND ITS CLAMP — an import-free leaf, for the same reason
 * `memory-sections.ts` is one.
 *
 * It lives here rather than in `notes.ts` because `links.ts` needs it to render a
 * `references` token as its target's title, and `notes.ts` needs `edgeTargets` from
 * `links.ts` to close the links a reverted body no longer mentions. That was a cycle. It
 * was BENIGN — every crossing edge is a hoisted `function` used only at call time, and no
 * module-level initializer in either file reads the other, so there is no TDZ under ESM or
 * under the CJS interop — and it was worth removing anyway: one future top-level `const`
 * derived across it fails at import with a message that names neither module usefully.
 *
 * The leaf takes the half that has no dependencies. `links.ts` now imports nothing from
 * `notes.ts`; `notes.ts` re-exports both names, so every existing caller — `tools.ts`, the
 * integration suite — is untouched by the move.
 */

/** `fitStatement`'s sibling, and the same three operations for the same reason: a note
 *  title is rendered into a byte-budgeted model tier and into the memory page's list, both
 *  of which are built for one line. 160 rather than 500 because a title is a label — the
 *  body is where the prose goes, and a title long enough to be prose is one that will be
 *  truncated by every surface that shows it anyway. */
export const NOTE_TITLE_MAX_CHARS = 160;

export function fitNoteTitle(raw: string): string {
  return raw.replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, NOTE_TITLE_MAX_CHARS);
}
