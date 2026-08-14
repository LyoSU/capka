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
 * Returns a statement that yields A ROW when the write is allowed and no rows when it is
 * not, taking `FOR NO KEY UPDATE` on the owning install. The lock is what makes it
 * equivalent to an in-statement predicate rather than a check-then-write gap: `claimApply`,
 * `markApplyFailed`, `finalizeApply` and the reaper are all UPDATEs on that same row, so
 * each blocks until the caller's transaction commits.
 *
 * Only the plugin-apply form lives here now. The manual one cannot be expressed as a single
 * statement at all — see `acquireFence`, which is what callers use.
 */
function applyFenceLock(authority: Extract<MutationAuthority, { kind: "plugin-apply" }>, source: string): SQL {
  return sql`
    SELECT 1 FROM plugin_installs pi
     WHERE ${source} = 'catalog:' || pi.id
       AND pi.manifest #>> '{applyState,status}' = 'applying'
       AND pi.manifest #>> '{applyState,operationId}' = ${authority.operationId}
       AND (pi.manifest #>> '{applyState,leaseExpiresAt}')::timestamptz > now()
     FOR NO KEY UPDATE`;
}

/** Anything that can run a raw statement: the global handle or a transaction. */
type FenceTx = { execute(query: SQL): Promise<{ rowCount: number | null }> };

/**
 * Take the fence for one `source` inside the caller's transaction, and say whether the write
 * may proceed. Every fenced INSERT goes through this.
 *
 * The manual authority needs TWO statements, and that is a correctness requirement rather
 * than a stylistic one. Its predicate used to be a single
 * `SELECT 1 WHERE NOT EXISTS (SELECT … WHERE applying FOR NO KEY UPDATE)` — and in the only
 * case that PROCEEDS, the subquery matches no row, so `FOR NO KEY UPDATE` locked nothing at
 * all. The answer was therefore free to go stale the instant it was computed: `claimApply`
 * could land immediately after, and the manual write went in underneath a claim it never
 * saw. A lock that only fires when the answer is "refuse" protects nothing.
 *
 * So the owning row is locked UNCONDITIONALLY first, and its status read afterwards — inside
 * one transaction, which is what makes the second read authoritative. A `source` belonging to
 * no install (a hand-added row, or the literal `"manual"`) locks nothing and passes, which is
 * correct: there is no apply that could own it.
 *
 * The plugin-apply form still needs one statement: its predicate matches the very row it
 * locks, so winning it and holding it are the same act.
 */
export async function acquireFence(tx: FenceTx, authority: MutationAuthority, source: string): Promise<boolean> {
  if (authority.kind !== "manual") {
    return ((await tx.execute(applyFenceLock(authority, source))).rowCount ?? 0) > 0;
  }
  await tx.execute(sql`
    SELECT 1 FROM plugin_installs pi
     WHERE ${source} = 'catalog:' || pi.id
     FOR NO KEY UPDATE`);
  const applying = await tx.execute(sql`
    SELECT 1 FROM plugin_installs pi
     WHERE ${source} = 'catalog:' || pi.id
       AND pi.manifest #>> '{applyState,status}' = 'applying'`);
  return (applying.rowCount ?? 0) === 0;
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
