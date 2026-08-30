/**
 * ONE normalization of a statement's text, for every question of the form "is this the
 * same wording as that".
 *
 * It existed twice, identically and by copy — `candidates.ts` used it to decide whether a
 * proposal duplicates a head, `migrate-memory-docs.ts` to build a stable idempotency key —
 * and the memory page's search box was about to be the third. Three copies of a rule is
 * this feature's recurring defect wearing a different hat: the copies agree today, and the
 * day one of them learns about apostrophes or non-breaking spaces the dedup and the search
 * quietly stop answering the same question, with nothing failing anywhere.
 *
 * Case-folded, trimmed, whitespace-collapsed, and deliberately nothing more. No language
 * list, no transliteration, no stemming: those are enumerated cases that go stale, and the
 * upgrade path for search is n-gram/embedding matching behind the same call site, not a
 * longer chain of `replace` here.
 */
export const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
