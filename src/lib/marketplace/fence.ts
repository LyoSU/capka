import { sql, type SQL } from "drizzle-orm";

/**
 * The mutation fence (docs/plugin-install-review-spec.md §7).
 *
 * A predicate that goes INSIDE the mutating statement, so there is no gap between
 * checking whether a write is allowed and performing it. A `SELECT` followed by an
 * `UPDATE` is exactly the race this exists to close: the apply can lose its lease, or
 * finish, between the two.
 */

/**
 * Who is writing. Explicit rather than inferred, because the two get DIFFERENT
 * predicates and picking the wrong one silently removes the protection.
 */
export type MutationAuthority =
  | { kind: "manual" }
  | { kind: "plugin-apply"; operationId: string };

/**
 * What a conditional write did. Never a boolean, and never a silent success on zero
 * rows: for an idempotent prune `missing` IS success, while `fenced` is always a
 * conflict, and a boolean cannot tell a caller which happened.
 */
export type WriteOutcome = "updated" | "missing" | "fenced";

/** Thrown by a writer that has no valid value to return when it is fenced — an upsert
 *  cannot produce an id for a row it was not allowed to write. */
export class FencedWriteError extends Error {
  constructor(what: string) {
    super(`Refusing to write ${what}: its plugin is being applied right now.`);
    this.name = "FencedWriteError";
  }
}

/**
 * The predicate for one authority against a table whose rows carry a `source` column.
 *
 * The two are DIFFERENT SQL, not one query with a parameter, and that is the whole point
 * of this function existing. A single "is anyone applying?" test has an inverted hole:
 * once the reconciler sets `failed`, no `applying` row exists at all, so a dispossessed
 * worker finds nothing in its way and proceeds. Copying only the manual predicate into an
 * apply path is the mistake this file exists to prevent.
 *
 * Install identity comes from the ROW's own `source`, never from a caller-supplied id, so
 * a wrong or forged id cannot select a different install's state.
 */
export function fencePredicate(authority: MutationAuthority, sourceColumn: SQL): SQL {
  if (authority.kind === "manual") {
    // Refuse while anyone is applying. A row that belongs to no install has no matching
    // plugin_installs row, so NOT EXISTS passes and hand-added rows are unaffected.
    return sql`NOT EXISTS (
      SELECT 1 FROM plugin_installs pi
       WHERE ${sourceColumn} = 'catalog:' || pi.id
         AND pi.manifest #>> '{applyState,status}' = 'applying'
    )`;
  }
  // Proceed only while the row is still ours AND the lease is alive. Every one of the
  // three conditions is load-bearing: after `failed`, after finalize (which clears
  // applyState), or after losing the lease, this predicate is false and the write is
  // fenced.
  return sql`EXISTS (
    SELECT 1 FROM plugin_installs pi
     WHERE ${sourceColumn} = 'catalog:' || pi.id
       AND pi.manifest #>> '{applyState,status}' = 'applying'
       AND pi.manifest #>> '{applyState,operationId}' = ${authority.operationId}
       AND (pi.manifest #>> '{applyState,leaseExpiresAt}')::timestamptz > now()
  )`;
}

/**
 * The INSERT case, which cannot use the predicate above: there is no row yet to read
 * `source` from, so the rule cannot live in a WHERE clause on the target table.
 *
 * This returns a statement that RETURNS A ROW when the write is allowed and no rows when
 * it is not, and that takes `FOR NO KEY UPDATE` on the owning install. The lock is what
 * makes it equivalent to an in-statement predicate rather than a check-then-write gap:
 * `claimApply`, `markApplyFailed`, `finalizeApply` and the reaper are all UPDATEs on that
 * same row, so each blocks until the caller's transaction commits, and the answer cannot
 * go stale before the insert lands. Run it inside a transaction with the insert.
 *
 * For a plugin apply the rule is stricter than for an update — the install must exist AND
 * be applying under our operation — which is also what makes a NEW orphan impossible.
 *
 * A row whose source is not `catalog:<id>` belongs to no install; the manual form then
 * matches nothing to refuse and the statement returns its one synthetic row.
 */
export function insertFenceLock(authority: MutationAuthority, source: string): SQL {
  if (authority.kind === "manual") {
    // One row unless some install owning this source is applying. The `FOR NO KEY UPDATE`
    // sits on the subquery so the same blocking applies.
    return sql`
      SELECT 1 WHERE NOT EXISTS (
        SELECT 1 FROM plugin_installs pi
         WHERE ${source} = 'catalog:' || pi.id
           AND pi.manifest #>> '{applyState,status}' = 'applying'
         FOR NO KEY UPDATE
      )`;
  }
  return sql`
    SELECT 1 FROM plugin_installs pi
     WHERE ${source} = 'catalog:' || pi.id
       AND pi.manifest #>> '{applyState,status}' = 'applying'
       AND pi.manifest #>> '{applyState,operationId}' = ${authority.operationId}
       AND (pi.manifest #>> '{applyState,leaseExpiresAt}')::timestamptz > now()
     FOR NO KEY UPDATE`;
}

/**
 * Turn a conditional write's row count into an outcome.
 *
 * `existed` is what an unconditional read said, so `missing` (the row is not there) can
 * be told apart from `fenced` (the row is there and the predicate refused). Collapsing
 * them would make an idempotent prune indistinguishable from a conflict.
 */
export function outcomeOf(rowsAffected: number, existed: boolean): WriteOutcome {
  if (rowsAffected > 0) return "updated";
  return existed ? "fenced" : "missing";
}

/** The default for every caller that is not a plugin apply. */
export const MANUAL: MutationAuthority = { kind: "manual" };
