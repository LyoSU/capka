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

/** SQL predicate: `sync_lease` belongs to this token AND has not expired. `n` is the
 *  1-based placeholder index the caller bound the token to. A matching token on an
 *  expired lease is deliberately NOT enough — it belongs to a sync that has already
 *  been superseded, whether or not anyone has claimed the folder yet. */
export function liveLeaseSql(n: number): string {
  return `sync_lease->>'token' = $${n} AND (sync_lease->>'expiresAt')::timestamptz > now()`;
}
