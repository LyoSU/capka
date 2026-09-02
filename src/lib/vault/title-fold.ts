/**
 * WHETHER A FAILED INSERT OR UPDATE IS THE TOPIC-TITLE FOLD REFUSING — an import-free leaf,
 * for the same reason `note-title.ts` and `memory-sections.ts` are ones.
 *
 * It moved out of `topics.ts` because a second module needs it and must not import that
 * one: `write-tools.ts` renames a file, a rename of a `memory_topic` row can collide with
 * `uniq_vnotes_topic_title`, and the two answers to "was that the fold?" have to be one
 * answer. A copy in the writer would go stale the day the index is renamed, and the failure
 * mode of a stale copy is the worst one available here — a real defect reported to the model
 * as routine reuse.
 *
 * NAMED RATHER THAN "any 23505". A foreign-key or check failure is a fault, and answering
 * one with "somebody already has this subject" would hide it. Drizzle wraps driver errors
 * from v0.36 on and keeps the `pg` error as `cause`; both shapes are read rather than
 * pinning a version — the same test `barrier.ts` makes.
 */

/** The index this predicate is about. `vault_notes` has no unique index on a plain note's
 *  title, deliberately: two files may be called the same thing, and only a TOPIC container —
 *  which is a heading on the person's own page — has to be unique. So a caller catching this
 *  is asking about `kind = 'memory_topic'` rows whether it says so or not. */
export const TOPIC_TITLE_INDEX = "uniq_vnotes_topic_title";

export function isTitleFoldConflict(e: unknown): boolean {
  const err = (e as { code?: unknown; constraint?: unknown }).code
    ? (e as { code?: unknown; constraint?: unknown })
    : ((e as { cause?: { code?: unknown; constraint?: unknown } }).cause ?? {});
  return err.code === "23505" && err.constraint === TOPIC_TITLE_INDEX;
}
