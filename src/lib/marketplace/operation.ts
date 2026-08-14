import { pool } from "@/lib/db";
import type { ApplyKind, ApplyState } from "./manifest-store";

/**
 * Serializing plugin applies (docs/plugin-install-review-spec.md §7).
 *
 * Every transition here is a compare-and-set against the install row's own
 * `manifest.applyState`, so two workers, a worker and the reconciler, or a worker and a
 * retry can never both believe they own an apply. This is the task queue's mechanism —
 * `LEASE_SECONDS`, a heartbeat CAS, `reconcileZombies` on expiry — reused rather than
 * reinvented, because the failure it prevents is the same one.
 */

/** Matches the task queue, for the same reason: long enough that a healthy but slow
 *  apply is not reaped, short enough that a dead one is noticed. */
export const APPLY_LEASE_SECONDS = 60;

/**
 * Margin past expiry before the reaper acts, so a single missed renewal — a transient DB
 * hiccup — does not take an apply away from a worker that is still running. The queue
 * needs this for exactly the same reason and uses the same value.
 */
const REAP_MARGIN_SECONDS = 15;

/**
 * What a `catch` is allowed to do, decided by WHERE the failure happened rather than by
 * what the exception was.
 *
 * A blanket `catch → failed` is wrong in both directions: it would record a failure
 * where nothing had changed, and — worse — where everything had already succeeded.
 */
export type ApplyPhase = "unclaimed" | "claimed" | "mutating" | "committed";

export type ClaimResult =
  | { ok: true; operationId: string }
  /** Someone else owns this install's apply, or the committed state moved under us. */
  | { ok: false; reason: "conflict" };

/**
 * Take ownership of an install's apply.
 *
 * The predicate is deliberately two conditions: the committed revision must be the one
 * the review was planned against, AND no live apply may be in flight. A `failed`
 * applyState IS claimable — that is the retry path — but an `applying` one is not, even
 * an expired one: the reconciler flips expired to `failed` first, so that a dispossessed
 * worker and a new claimant can never both be `applying`.
 */
export async function claimApply(input: {
  installId: string;
  operationId: string;
  expectedRevision: number;
  targetSha: string;
  kind: ApplyKind;
}): Promise<ClaimResult> {
  // A non-finite expected revision means the row's counter could not be read; refuse
  // before touching the database rather than sending NaN into SQL, where it would
  // compare as NULL and could match nothing OR everything depending on the operator.
  if (!Number.isFinite(input.expectedRevision)) return { ok: false, reason: "conflict" };

  const { rowCount } = await pool.query(
    `UPDATE plugin_installs
        SET manifest = coalesce(manifest, '{}'::jsonb) || jsonb_build_object('applyState', jsonb_build_object(
              'operationId', $2::text,
              'targetSha', $3::text,
              'status', 'applying',
              'kind', $4::text,
              'startedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'leaseExpiresAt', to_char((now() + ($5 || ' seconds')::interval) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ))
      WHERE id = $1
        AND coalesce((manifest #>> '{committedRevision}')::bigint, 0) = $6::bigint
        AND (manifest #>> '{applyState,status}' IS NULL OR manifest #>> '{applyState,status}' = 'failed')`,
    [input.installId, input.operationId, input.targetSha, input.kind, String(APPLY_LEASE_SECONDS), String(input.expectedRevision)],
  );
  return (rowCount ?? 0) > 0 ? { ok: true, operationId: input.operationId } : { ok: false, reason: "conflict" };
}

/** Renew the lease. False means the operation is no longer ours — the reaper won, or it
 *  already finished — and the caller must stop mutating immediately. */
export async function renewApplyLease(installId: string, operationId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE plugin_installs
        SET manifest = jsonb_set(manifest, '{applyState,leaseExpiresAt}',
              to_jsonb(to_char((now() + ($3 || ' seconds')::interval) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      WHERE id = $1
        AND manifest #>> '{applyState,operationId}' = $2
        AND manifest #>> '{applyState,status}' = 'applying'`,
    [installId, operationId, String(APPLY_LEASE_SECONDS)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Publish the new committed view and drop the claim, in one statement.
 *
 * The `manifest` argument must already carry its bumped `committedRevision`; this
 * function only decides WHETHER it may land. Finalize is the publication moment: until
 * it lands, the runtime cannot see any of this install's resources.
 */
export async function finalizeApply(input: {
  installId: string;
  operationId: string;
  manifest: Record<string, unknown>;
}): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE plugin_installs
        SET manifest = $3::jsonb
      WHERE id = $1
        AND manifest #>> '{applyState,operationId}' = $2
        AND manifest #>> '{applyState,status}' = 'applying'
        AND (manifest #>> '{applyState,leaseExpiresAt}')::timestamptz > now()`,
    [input.installId, input.operationId, JSON.stringify(input.manifest)],
  );
  return (rowCount ?? 0) > 0;
}

/** Record that resources were already changed and the apply did not finish. Only the
 *  owning operation may do this — a foreign id must not be able to mark someone else's
 *  apply failed. */
export async function markApplyFailed(installId: string, operationId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE plugin_installs
        SET manifest = jsonb_set(manifest, '{applyState,status}', '"failed"'::jsonb)
      WHERE id = $1
        AND manifest #>> '{applyState,operationId}' = $2
        AND manifest #>> '{applyState,status}' = 'applying'`,
    [installId, operationId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Give a claim back when NOTHING has been mutated yet.
 *
 * Release is not one operation, and conflating the three either strands a staging row or
 * destroys a state the operator still needs to see:
 *
 * - `install` — delete the staging row; there is no committed state to return to.
 * - `upgrade` — clear `applyState`, leaving the committed view exactly as it was.
 * - `retry` — restore `failed`, NOT null: the earlier failure is still true and must
 *   stay visible, or a retry that itself went stale would quietly erase the problem.
 *
 * The row cannot infer which applies — a staging row and a claimed ready install look
 * identical once `applyState` is set — which is why the claim records its `kind`.
 */
export async function releaseApplyClaim(installId: string, operationId: string, kind: ApplyKind): Promise<boolean> {
  if (kind === "install") {
    const { rowCount } = await pool.query(
      `DELETE FROM plugin_installs
        WHERE id = $1 AND manifest #>> '{applyState,operationId}' = $2 AND manifest #>> '{applyState,status}' = 'applying'`,
      [installId, operationId],
    );
    return (rowCount ?? 0) > 0;
  }
  const { rowCount } = await pool.query(
    kind === "retry"
      ? `UPDATE plugin_installs SET manifest = jsonb_set(manifest, '{applyState,status}', '"failed"'::jsonb)
          WHERE id = $1 AND manifest #>> '{applyState,operationId}' = $2 AND manifest #>> '{applyState,status}' = 'applying'`
      : `UPDATE plugin_installs SET manifest = manifest - 'applyState'
          WHERE id = $1 AND manifest #>> '{applyState,operationId}' = $2 AND manifest #>> '{applyState,status}' = 'applying'`,
    [installId, operationId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Flip every apply whose lease has expired to `failed`.
 *
 * It never RESUMES one: the executable plan may have existed only in memory and the
 * observations have moved, so continuing would apply something nobody reviewed. This
 * matches the queue's stance — a lost lease fails a task and nothing is ever requeued.
 *
 * Racing the worker's own renewal through the same CAS is the point: whoever wins, the
 * loser can no longer mutate or finalize.
 */
export async function reconcileStaleApplies(): Promise<{ installId: string; operationId: string; kind: ApplyKind }[]> {
  const { rows } = await pool.query<{ install_id: string; operation_id: string; kind: ApplyKind }>(
    `UPDATE plugin_installs
        SET manifest = jsonb_set(manifest, '{applyState,status}', '"failed"'::jsonb)
      WHERE manifest #>> '{applyState,status}' = 'applying'
        AND (manifest #>> '{applyState,leaseExpiresAt}')::timestamptz < now() - ($1 || ' seconds')::interval
      RETURNING id AS install_id,
                manifest #>> '{applyState,operationId}' AS operation_id,
                coalesce(manifest #>> '{applyState,kind}', 'upgrade') AS kind`,
    [String(REAP_MARGIN_SECONDS)],
  );
  return rows.map((r) => ({ installId: r.install_id, operationId: r.operation_id, kind: r.kind }));
}

/** Read an install's apply state without going through the whole manifest reader — for a
 *  status endpoint or a test. */
export async function readApplyState(installId: string): Promise<ApplyState | null> {
  const { rows } = await pool.query<{ apply_state: ApplyState | null }>(
    `SELECT manifest -> 'applyState' AS apply_state FROM plugin_installs WHERE id = $1`,
    [installId],
  );
  return rows[0]?.apply_state ?? null;
}
