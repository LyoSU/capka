/**
 * The one condition that says a folder's sync lease is still a given sync's to use.
 *
 * A sync holds the lease across its whole span and makes TWO kinds of write through
 * the API — the bulk upload and the merge-ancestor swap — so both have to be fenced
 * on the same condition. Kept here rather than written out twice: the lease lives in
 * a jsonb column, and a change to its shape that updated one copy and missed the
 * other would leave a write silently unfenced, which is exactly the hole the lease
 * exists to close.
 */

/** A lease that has not run out yet. A matching token on an expired lease is
 *  deliberately never enough — it belongs to a sync that has already been
 *  superseded, whether or not anyone has claimed the folder since. `sync_lease` may
 *  be NULL, and then this is NULL rather than true, so "no lease" never counts as
 *  a live one. */
const LIVE = `(sync_lease->>'expiresAt')::timestamptz > now()`;

/** SQL predicate: `sync_lease` belongs to this token AND has not expired. `n` is the
 *  1-based placeholder index the caller bound the token to. */
export function liveLeaseSql(n: number): string {
  return `sync_lease->>'token' = $${n} AND ${LIVE}`;
}

/** SQL predicate: the row is under a live lease that is NOT this token's — the
 *  folder is somebody else's to write, right now.
 *
 *  This is the form a write has to be refused on, and it is not the negation of
 *  `liveLeaseSql`: a caller that simply omits the token must be refused too, and
 *  omission arrives as NULL. `=` and `<>` both answer NULL there, which is not true,
 *  so either would have let an unaccompanied request straight through — the exact
 *  bypass this predicate exists to close. `IS DISTINCT FROM` treats a missing token
 *  as "not the holder", which is what it is. `n` is the token's placeholder index;
 *  bind NULL when the request named none. */
export function heldByOtherSql(n: number): string {
  return `${LIVE} AND sync_lease->>'token' IS DISTINCT FROM $${n}`;
}
