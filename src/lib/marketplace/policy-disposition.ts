import { sql } from "drizzle-orm";
import { pool } from "@/lib/db";
import type { CapabilityType } from "@/lib/governance/types";
import type { PolicyDisposition } from "./review";

/**
 * What happens to a permission rule when the resource it names goes away
 * (docs/plugin-install-review-spec.md §6).
 *
 * Policies are keyed `(capabilityType, capabilityKey)` where the key is the resource
 * NAME — `run-context.ts` asks `policy.effect("connector", name)` and knows nothing about
 * `source`. That single fact drives everything here: a removal does not orphan a policy by
 * itself, because another resource of the same name may already be answering to it.
 */

/** One policy row a review has an opinion about. */
export interface PolicyBaselineRow {
  id: string;
  capabilityType: CapabilityType;
  capabilityKey: string;
  effect: string;
  scope: string;
  userId: string | null;
  projectId: string | null;
  /** The CAS token. Covers every column at once, where a field list would have to be
   *  exhaustive to be safe. */
  revision: number;
}

/**
 * Stable identity for a policy row inside a review, independent of its surrogate id.
 *
 * The id would be simpler but it is not stable across a delete-and-recreate, and a review
 * has to survive an admin removing and re-adding the same rule between preview and apply —
 * that must read as a CHANGED baseline, which the revision catches, not as a vanished row.
 */
export function policyKey(r: Pick<PolicyBaselineRow, "scope" | "capabilityType" | "capabilityKey" | "userId" | "projectId">): string {
  return [r.scope, r.capabilityType, r.capabilityKey, r.userId ?? "", r.projectId ?? ""].join(":");
}

/**
 * Every policy row naming any of `names`, whatever its scope or subject.
 *
 * Deliberately not narrowed to the installer's own scope: a system-scope rule and a
 * per-project exception on the same name are both affected by the resource going away, and
 * a review that showed only one of them would describe a smaller change than the one being
 * consented to.
 */
export async function readPolicyBaseline(
  names: { type: CapabilityType; name: string }[],
): Promise<PolicyBaselineRow[]> {
  if (names.length === 0) return [];
  // Two parallel arrays zipped by `unnest`, rather than a composite-type cast: the pair
  // has to match exactly, and building `(type,name)` literals would need its own escaping
  // for a name containing a comma or a quote.
  const { rows } = await pool.query<{
    id: string; capability_type: CapabilityType; capability_key: string; effect: string;
    scope: string; user_id: string | null; project_id: string | null; revision: string;
  }>(
    `SELECT id, capability_type, capability_key, effect, scope, user_id, project_id, revision
       FROM capability_policies
      WHERE (capability_type, capability_key)
            IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [names.map((n) => n.type), names.map((n) => n.name)],
  );
  return rows.map((r) => ({
    id: r.id, capabilityType: r.capability_type, capabilityKey: r.capability_key,
    effect: r.effect, scope: r.scope, userId: r.user_id, projectId: r.project_id,
    revision: Number(r.revision),
  }));
}

/** `policyKey` → `revision`, the shape `reviewHash` folds in. A wider baseline is what
 *  covers a hand edit the apply-state fence cannot: the policy tables are not
 *  plugin-owned, so an admin editing one mid-apply is not refused — it simply makes the
 *  review stale, which the second hash check catches before a single resource is written. */
export function policyRevisions(rows: PolicyBaselineRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [policyKey(r), r.revision]));
}

export interface PolicyOutlook {
  key: string;
  capabilityType: CapabilityType;
  capabilityKey: string;
  effect: string;
  /**
   * Whether a resource of this name will still exist after the apply.
   *
   * `still_applies` — another resource answers to this name, so the rule keeps working and
   * saying "this permission will be removed" would be false.
   * `applies_to_nothing` — nothing answers to it right now, and if something with this
   * name appears later the rule will apply to that. Which is exactly why deleting is a
   * CHOICE and not a cleanup: leaving it is a standing rule for a future resource.
   */
  outlook: "still_applies" | "applies_to_nothing";
}

/**
 * What each affected rule will mean once the apply lands — the analysis the review screen
 * renders and the installer decides against.
 *
 * Pure: takes the names that survive rather than querying, so the same function serves the
 * preview and the apply-time re-check and cannot disagree with itself between them.
 */
export function analysePolicies(input: {
  affected: PolicyBaselineRow[];
  /** Names that will exist after the apply, by type. */
  survivingNames: { type: CapabilityType; name: string }[];
}): PolicyOutlook[] {
  const surviving = new Set(input.survivingNames.map((n) => `${n.type}:${n.name}`));
  return input.affected.map((r) => ({
    key: policyKey(r),
    capabilityType: r.capabilityType,
    capabilityKey: r.capabilityKey,
    effect: r.effect,
    outlook: surviving.has(`${r.capabilityType}:${r.capabilityKey}`) ? "still_applies" : "applies_to_nothing",
  }));
}

export class StalePolicyError extends Error {
  constructor(key: string) {
    super(`Policy ${key} changed after the review was accepted`);
    this.name = "StalePolicyError";
  }
}

/** A disposition the actor is not entitled to make. Distinct from `StalePolicyError`,
 *  which means the world moved: this one means the request should never have been made. */
export class ForbiddenDispositionError extends Error {
  constructor(key: string, why: string) {
    super(`Not allowed to change policy ${key}: ${why}`);
    this.name = "ForbiddenDispositionError";
  }
}

/** Who is asking. Not derived from the install's scope — a PERSONAL install may name an
 *  org-wide rule in its baseline, so the actor's own authority is what decides. */
export interface DispositionActor {
  userId: string;
  isAdmin: boolean;
}

/**
 * Decide whether this actor may carry out this disposition, given the outlook the review
 * computed. Pure, so the route and the apply cannot disagree.
 *
 * Two independent gates, and BOTH are load-bearing:
 *
 * 1. **Ownership.** `readPolicyBaseline` deliberately returns rules of every scope, because
 *    a review that showed only the installer's own would describe a smaller change than the
 *    one being consented to. Showing is not touching: a non-admin may delete only a rule
 *    that is theirs — `scope = 'user'` AND `user_id = them`. Without this, a member could
 *    install a personal plugin declaring a resource named to match an org-wide `deny`, name
 *    that rule in `dispositions`, and delete it — and a missing rule is DEFAULT ALLOW
 *    (`buildMatcher`), so that is privilege escalation, not cleanup.
 *
 * 2. **The outlook.** Only a rule that will apply to nothing may be deleted. A rule that
 *    still governs a surviving resource is not part of this decision at all, and the UI
 *    never offers it — so a request to delete one is forged by construction.
 *
 * The review hash cannot substitute for either. The client supplies the dispositions AND
 * the server recomputes the hash *with them*, so a forged disposition simply produces a
 * different valid hash: the first attempt 409s with a fresh review, and the second one —
 * carrying that hash — would succeed. A hash proves nothing was swapped underneath; it
 * cannot prove the asker was entitled to ask.
 */
export function assertDispositionAllowed(
  key: string,
  disposition: PolicyDisposition,
  row: PolicyBaselineRow,
  outlook: PolicyOutlook | undefined,
  actor: DispositionActor,
): void {
  if (disposition === "keep") return;
  if (!actor.isAdmin && !(row.scope === "user" && row.userId === actor.userId)) {
    throw new ForbiddenDispositionError(key, "only an admin can change a rule that is not your own");
  }
  if (!outlook) throw new ForbiddenDispositionError(key, "this rule is not part of the review");
  if (outlook.outlook !== "applies_to_nothing") {
    throw new ForbiddenDispositionError(key, "this rule still applies to a resource that remains");
  }
}

/**
 * Carry out the dispositions the installer accepted, inside the caller's transaction.
 *
 * A revision CAS rather than a field-by-field predicate. The policy's identity spans
 * `(scope, capabilityType, capabilityKey, userId, projectId)` plus `effect`, two of those
 * nullable — so any field omitted from a comparison is a hole, and a concurrent change to
 * the omitted one would slip past and delete a rule the review never analysed. One token
 * covers every column and cannot be under-specified.
 *
 * Zero rows means the row moved between the second hash check and this write — a window
 * the fence does not cover — so it THROWS and aborts the transaction. The operation then
 * becomes `failed`, which is legible, rather than `succeeded`, which would be a lie: an
 * earlier draft skipped the disposition and still finalized, which applied the resource
 * half of a decision and dropped the policy half.
 */
export async function applyDispositions(
  tx: { execute(q: ReturnType<typeof sql>): Promise<{ rowCount: number | null }> },
  input: {
    dispositions: Record<string, PolicyDisposition>;
    baseline: PolicyBaselineRow[];
    /** The outlook the review computed, per key. A disposition for a key with no outlook is
     *  not part of the reviewed decision and is refused. */
    outlooks: PolicyOutlook[];
    /** REQUIRED. Ownership is checked here rather than at the route, so no future caller can
     *  reach this function without it. */
    actor: DispositionActor;
  },
): Promise<{ deleted: PolicyBaselineRow[] }> {
  const byKey = new Map(input.baseline.map((r) => [policyKey(r), r]));
  const outlookByKey = new Map(input.outlooks.map((o) => [o.key, o]));
  const deleted: PolicyBaselineRow[] = [];
  for (const [key, disposition] of Object.entries(input.dispositions)) {
    if (disposition === "keep") continue;
    const row = byKey.get(key);
    // A disposition naming a row that is no longer in the baseline is itself a stale
    // review: the installer decided about something that has since changed.
    if (!row) throw new StalePolicyError(key);
    // Entitlement BEFORE the write, and before the CAS: a forged disposition must be
    // refused outright, not merely lose a race.
    assertDispositionAllowed(key, disposition, row, outlookByKey.get(key), input.actor);
    if (disposition === "delete") {
      const res = await tx.execute(sql`
        DELETE FROM capability_policies WHERE id = ${row.id} AND revision = ${row.revision}`);
      if ((res.rowCount ?? 0) === 0) throw new StalePolicyError(key);
      // The ROW, not the key: `policy.clear` has to record what the rule contained, and
      // after the delete it is unreconstructable.
      deleted.push(row);
      continue;
    }
    // `reassign` exists to MOVE a rule to a renamed resource, and moving it needs a
    // target the review does not yet carry. Refusing loudly is correct until it does:
    // silently treating it as `keep` would apply something other than what was accepted.
    throw new Error(`Policy disposition "reassign" is not implemented yet (key ${key})`);
  }
  return { deleted };
}
