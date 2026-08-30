/**
 * ONE normalization of a statement's text, for every question of the form "is this the
 * same wording as that" — asked LIVE, against rows read a moment ago, never persisted.
 *
 * Shared by `candidates.ts` (does a proposal duplicate a head that exists right now?) and
 * `memory-page.ts` (does a head's text contain the search words typed right now?). Both
 * questions are asked fresh against the current data every time, so both are free to
 * change this function's answer whenever a better one is found — an apostrophe folded, a
 * non-breaking space collapsed, Unicode NFC applied.
 *
 * `migrate-memory-docs.ts` used to share this function too, to build a persisted
 * idempotency key. It no longer does: that key is written into a column under a unique
 * index and must never change once chosen, which is the opposite requirement from the two
 * callers here, so it now keeps its own frozen copy (`legacyIdemKeyNorm`) instead. Do not
 * "consolidate" that copy back into this one — see its docstring for why that undoes a
 * fix.
 *
 * Case-folded, trimmed, whitespace-collapsed, and deliberately nothing more. No language
 * list, no transliteration, no stemming: those are enumerated cases that go stale, and the
 * upgrade path for search is n-gram/embedding matching behind the same call site, not a
 * longer chain of `replace` here.
 */
export const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
