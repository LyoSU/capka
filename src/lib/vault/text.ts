/**
 * ONE normalization of a statement's text, for every question of the form "is this the
 * same wording as that" — asked LIVE, against rows read a moment ago, never persisted.
 *
 * Shared by `candidates.ts` (does a proposal duplicate a head that exists right now?),
 * `memory-page.ts` (does a head's text contain the search words typed right now?) and
 * `eval/topic-reuse.ts`. Every one of those questions is asked fresh against the current
 * data every time, so each of those three is free to change this function's answer whenever
 * a better one is found.
 *
 * A FOURTH CALLER TOOK THAT FREEDOM AWAY, and it is the one an edit will not think to look
 * for: `model-view.ts`'s `fusedCandidates` normalizes the model's query words here and then
 * matches them against `vault_search_documents.norm_model_text` / `norm_title` — which are
 * `GENERATED ALWAYS` columns computed by the SQL `normalized()` expression in `schema.ts`,
 * over every stored row, behind GIN indexes. So this function is now PINNED to a SQL twin
 * across a populated table, and the three edits this docstring used to offer as examples —
 * folding an apostrophe, collapsing a non-breaking space, applying NFC — are precisely the
 * ones that would desynchronize the query side from every row already projected.
 *
 * Changing it therefore means: widen `normalized()` in `schema.ts` in the same commit, and
 * rebuild the generated columns for every existing row. The parity test in
 * `search-documents.integration.test.ts` fails the mismatch rather than letting it ship —
 * and it points a reader here for the reasoning, which is why this paragraph has to be
 * true and not merely present.
 *
 * TWO callers used to share this function to build a PERSISTED key and no longer do:
 * `migrate-memory-docs.ts` (`memory_candidates.idempotency_key`, under `uniq_mcand_idem`)
 * and `claims.ts` (`vault_claims.normalized_hash`, under `idx_vclaims_norm_hash`). Such a
 * key must never change once chosen, which is the opposite requirement from the live
 * callers above, so each keeps its own frozen copy — `legacyIdemKeyNorm` and
 * `dedupKeyNorm` respectively. Do not "consolidate" either copy back into this one; see
 * their docstrings for why that undoes a fix. That this has now happened twice is the
 * reason the rule is written here rather than only there: a new persisted key gets its
 * OWN frozen copy, it does not import this.
 *
 * A THIRD now exists: `topics.ts`'s `topicTitleNorm`, the JS twin of
 * `uniq_vnotes_topic_title`'s SQL expression. Same rule, third instance — which is why
 * that rule is written here rather than only at the two sites that first needed it.
 *
 * AND THE THIRD CARRIES THE COROLLARY, because freezing was not enough for it. Its
 * expression ends in `lower()`, and `lower()` follows the database's collation while
 * `toLowerCase()` follows Unicode default casing: they disagree on U+0130 and on a
 * word-final capital sigma, so the "frozen copy" was faithful in two of its three
 * operations and quietly wrong in the third. A copy can only be frozen against something
 * it can actually reproduce. Where it cannot — a collation-dependent fold, a
 * locale-dependent comparison — the answer is not a better JS copy but NO JS copy: compute
 * the key in SQL on both sides, as `topics.ts` now does, and keep the JS rendering for
 * messages and for the parity test that says which operations it is still honest about.
 *
 * Case-folded, trimmed, whitespace-collapsed, and deliberately nothing more. No language
 * list, no transliteration, no stemming: those are enumerated cases that go stale, and the
 * upgrade path for search is n-gram/embedding matching behind the same call site, not a
 * longer chain of `replace` here.
 */
export const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
