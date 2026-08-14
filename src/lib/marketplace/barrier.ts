import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls } from "@/lib/db/schema";
import { getBlockPrivateProviderUrls, getMasterKey } from "@/lib/settings";
import { log } from "@/lib/log";
import { insertPluginAudit, insertPolicyClearAudit } from "./audit";
import { classifyDelta } from "./delta";
import { FencedWriteError } from "./fence";
import { readStoredManifest, type ApplyKind } from "./manifest-store";
import { observePluginPlan } from "./observe";
import {
  APPLY_LEASE_SECONDS, claimApply, finalizeApply, markApplyFailed, releaseApplyClaim, renewApplyLease,
} from "./operation";
import { buildPluginPlan } from "./plan";
import {
  ForbiddenDispositionError, analysePolicies, applyDispositions, policyRevisions,
  readPolicyBaseline, type DispositionActor, type PolicyOutlook,
} from "./policy-disposition";
import { projectPlanSurface } from "./project";
import { projectPluginReview, type PolicyDisposition, type ReviewResponse, type ReviewSubject } from "./review";
import { emptySurface, readRuntimeSurface } from "./runtime-surface";
import type { StoredInstallSurface } from "./surface";

/**
 * The apply barrier (docs/plugin-install-review-spec.md §7).
 *
 * Two hash checks, not one. The first refuses a review that went stale before anything is
 * touched. The second runs INSIDE the claim, because the window between "we decided to
 * apply" and "we own the right to apply" is exactly where someone else's upgrade lands.
 */

/** A 64-hex digest, which is what `reviewHash` produces. */
const HASH_RE = /^[0-9a-f]{64}$/;

/** Someone else owns this apply. Thrown to abort the claiming transaction so nothing it
 *  inserted survives — an expected outcome, deliberately not logged as a fault. */
class StagingConflict extends Error {}

export interface ApplyRequest {
  marketplaceId: string;
  pluginName: string;
  scope: "system" | "user";
  ownerId: string | null;
  targetSha: string;
  only?: string[];
  actorId: string;
  reviewHash: string;
  dispositions: Record<string, PolicyDisposition>;
  /** The asker's own authority, NOT the install's scope. A personal install may name an
   *  org-wide rule in its baseline, so what decides is who is asking. */
  actor: DispositionActor;
}

export type ApplyOutcome =
  | { outcome: "succeeded" }
  /** The review no longer describes reality. Carries the FRESH review so the caller can
   *  re-present it without another round trip — which does not close the new window, and
   *  is why the next attempt rebuilds everything again. */
  | { outcome: "stale"; review: ReviewResponse; policies: PolicyOutlook[] }
  | { outcome: "blocked"; review: ReviewResponse; policies: PolicyOutlook[] }
  | { outcome: "failed"; errorCode: string }
  /** The request itself was not acceptable — no operation was started and nothing is
   *  audited, because nothing was attempted. */
  | { outcome: "rejected"; reason: "malformed_hash" };

/** Everything a review needs, gathered fresh. Used identically by the preview and by the
 *  apply, so the two cannot compute a different picture from the same inputs. */
async function gather(input: {
  gh: { owner: string; repo: string; ref: string; subdir: string };
  subject: ReviewSubject;
  installId: string | null;
  storedManifestRaw: unknown;
}) {
  const keyHex = await getMasterKey();
  const plan = await buildPluginPlan(input.gh, input.subject.only ?? undefined);
  const observations = await observePluginPlan(plan, { blockPrivate: await getBlockPrivateProviderUrls() });
  const sourceAfter = projectPlanSurface(plan, observations, keyHex);

  const stored = readStoredManifest(input.storedManifestRaw);
  // A first install's baseline is EMPTY, not unknown: nothing existed, which is a known
  // fact and makes every resource an `expansion`. A legacy row's baseline is genuinely
  // unknown — it stored no surface — and `null` is what the delta reads as `unknown`.
  const isFirst = input.installId === null;
  const sourceBefore: StoredInstallSurface | null = isFirst ? emptySurface() : stored.installSurface;
  const runtimeBefore: StoredInstallSurface | null = isFirst
    ? emptySurface()
    : sourceBefore === null
      // No committed artifact means no identity to compare rows against, so reporting the
      // rows would manufacture a full replacement out of missing information.
      ? null
      : await readRuntimeSurface(input.installId!, sourceBefore, keyHex);

  const delta = classifyDelta({ sourceBefore, runtimeBefore, sourceAfter, urls: observations.urls });

  // Policies are keyed by resource NAME, so the affected set is every rule naming anything
  // this operation touches on either side — not just the removals, because the review has
  // to say what each rule will mean afterwards.
  const names = [
    ...sourceAfter.connectors.map((c) => ({ type: "connector" as const, name: c.name })),
    ...sourceAfter.skills.map((s) => ({ type: "skill" as const, name: s.name })),
    ...(sourceBefore?.connectors ?? []).map((c) => ({ type: "connector" as const, name: c.name })),
    ...(sourceBefore?.skills ?? []).map((s) => ({ type: "skill" as const, name: s.name })),
  ];
  const policyBaseline = await readPolicyBaseline(names);
  const policies = analysePolicies({
    affected: policyBaseline,
    survivingNames: [
      ...sourceAfter.connectors.map((c) => ({ type: "connector" as const, name: c.name })),
      ...sourceAfter.skills.map((s) => ({ type: "skill" as const, name: s.name })),
    ],
  });

  return { keyHex, plan, observations, sourceBefore, runtimeBefore, sourceAfter, delta, policyBaseline, policies, stored };
}

/**
 * Build the review the installer sees. Touches nothing.
 *
 * Opening or dismissing this is deliberately NOT audited: closing a dialog is not a
 * decision, and a record per preview would make the trail unreadable exactly where it has
 * to be legible.
 */
export async function previewPluginApply(input: {
  gh: { owner: string; repo: string; ref: string; subdir: string };
  marketplaceId: string;
  pluginName: string;
  scope: "system" | "user";
  ownerId: string | null;
  installId: string | null;
  targetSha: string;
  only?: string[];
  storedManifestRaw: unknown;
  dispositions?: Record<string, PolicyDisposition>;
}): Promise<{ review: ReviewResponse; policies: PolicyOutlook[] }> {
  const subject: ReviewSubject = {
    kind: input.installId === null ? "install" : "upgrade",
    installId: input.installId, marketplaceId: input.marketplaceId, pluginName: input.pluginName,
    scope: input.scope, ownerId: input.ownerId, targetSha: input.targetSha,
    only: input.only?.length ? input.only : null,
  };
  const g = await gather({ gh: input.gh, subject, installId: input.installId, storedManifestRaw: input.storedManifestRaw });
  const { response } = projectPluginReview({
    subject, plan: g.plan, observations: g.observations,
    sourceBefore: g.sourceBefore, runtimeBefore: g.runtimeBefore, sourceAfter: g.sourceAfter,
    delta: g.delta,
    // The dispositions are part of the hash, so a preview with none produces a DIFFERENT
    // hash than the accept that carries them. That is correct: they are part of the
    // decision, so the screen re-derives the hash once the installer has chosen.
    dispositions: input.dispositions ?? {},
    policyRevisions: policyRevisions(g.policyBaseline),
  });
  return { review: response, policies: g.policies };
}

/**
 * Apply exactly what was reviewed, or refuse.
 *
 * The order of the first two steps is deliberate: a malformed hash is refused SYNTACTICALLY,
 * before any database access at all, while resolving who may do this needs the DB. Doing it
 * the other way round would let a garbage request cost a query.
 */
export async function applyPluginReviewed(input: ApplyRequest & {
  gh: { owner: string; repo: string; ref: string; subdir: string };
  installId: string | null;
  /** Performs the writes, given the authority to do so. Injected so the barrier owns the
   *  serialization and knows nothing about routing resources. */
  performWrites: (args: {
    operationId: string;
    plan: Awaited<ReturnType<typeof buildPluginPlan>>;
    observations: Awaited<ReturnType<typeof observePluginPlan>>;
    installId: string;
  }) => Promise<Record<string, unknown>>;
}): Promise<ApplyOutcome> {
  if (!HASH_RE.test(input.reviewHash)) return { outcome: "rejected", reason: "malformed_hash" };

  const kind: ApplyKind = input.installId === null ? "install" : "upgrade";
  const subject: ReviewSubject = {
    kind, installId: input.installId, marketplaceId: input.marketplaceId, pluginName: input.pluginName,
    scope: input.scope, ownerId: input.ownerId, targetSha: input.targetSha,
    only: input.only?.length ? input.only : null,
  };

  const row = input.installId
    ? (await db.select({ manifest: pluginInstalls.manifest }).from(pluginInstalls).where(eq(pluginInstalls.id, input.installId)).limit(1))[0]
    : undefined;

  const build = async () => {
    const g = await gather({ gh: input.gh, subject, installId: input.installId, storedManifestRaw: row?.manifest });
    const projected = projectPluginReview({
      subject, plan: g.plan, observations: g.observations,
      sourceBefore: g.sourceBefore, runtimeBefore: g.runtimeBefore, sourceAfter: g.sourceAfter,
      delta: g.delta, dispositions: input.dispositions, policyRevisions: policyRevisions(g.policyBaseline),
    });
    return { ...g, ...projected };
  };

  const first = await build();
  const targetKey = `${input.pluginName}`;

  // A refusal is audited BEFORE any claim, and that is the one thing invariant 3 permits to
  // happen unclaimed: a refusal that left no trace would hide exactly the attempts worth
  // seeing.
  if (first.durable.reviewHash !== input.reviewHash) {
    await insertPluginAudit(db, { operationId: `stale-${nanoid(8)}`, event: "stale", actorId: input.actorId, reviewHash: input.reviewHash, targetKey });
    return { outcome: "stale", review: first.response, policies: first.policies };
  }
  // A valid hash does NOT override an inability to proceed. DNS may have turned unsafe
  // since the review, which is not a different consent but a reason there is nothing safe
  // to apply.
  if (first.delta.gate === "cannot_apply") {
    await insertPluginAudit(db, { operationId: `blocked-${nanoid(8)}`, event: "blocked", actorId: input.actorId, reviewHash: input.reviewHash, targetKey });
    return { outcome: "blocked", review: first.response, policies: first.policies };
  }

  const operationId = `op_${nanoid(12)}`;
  const installId = input.installId ?? nanoid();

  // ── claimed ────────────────────────────────────────────────────────────────────
  // For a first install the staging INSERT *is* the claim — the partial unique indexes make
  // one of two parallel attempts fail — so the row is INSERTED ALREADY CLAIMED, in the same
  // transaction as the `accepted` entry.
  //
  // Inserting it first and claiming afterwards left a window where a crash between the two
  // stranded a row with no applyState: permanently `ready`, permanently empty, invisible to
  // the reaper (which only looks at `applying`), and blocking every retry through the unique
  // index. Building the claim into the insert removes the window rather than narrowing it.
  const stagedApplyState = {
    operationId, targetSha: input.targetSha, status: "applying" as const, kind,
    reviewHash: input.reviewHash,
    startedAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + APPLY_LEASE_SECONDS * 1000).toISOString(),
  };
  // The claim and its `accepted` entry are ONE transaction. A journal write that cannot
  // land rolls the claim back, so an install is never left claimed with no record of who
  // claimed it — and `insertPluginAudit` throws precisely so that rollback happens.
  let claimed = false;
  try {
    claimed = await db.transaction(async (tx) => {
      if (input.installId === null) {
        try {
          await tx.insert(pluginInstalls).values({
            id: installId, marketplaceId: input.marketplaceId, pluginName: input.pluginName,
            scope: input.scope, userId: input.ownerId, installedBy: input.actorId,
            manifest: {
              schemaVersion: 2, inventory: { skills: [], connectors: [], ignored: [], notes: [] },
              installSurface: null, committedRevision: 0, applyState: stagedApplyState,
            },
          });
        } catch {
          // Someone else's first install won the unique index. Theirs is in flight; ours is
          // stale. The transaction is aborted by the constraint, so nothing is stranded.
          throw new StagingConflict();
        }
      } else {
        const claim = await claimApply({
          installId, operationId, expectedRevision: first.stored.committedRevision,
          targetSha: input.targetSha, kind, reviewHash: input.reviewHash,
        }, tx);
        if (!claim.ok) throw new StagingConflict();
      }
      await insertPluginAudit(tx, {
        operationId, event: "accepted", actorId: input.actorId,
        review: first.durable, reviewHash: input.reviewHash, targetKey,
      });
      return true;
    });
  } catch (e) {
    // A conflict is an expected outcome, not a fault: someone else owns this apply.
    if (!(e instanceof StagingConflict)) {
      log.error("plugin apply could not record its claim", { installId, operationId, err: String(e) });
    }
  }
  if (!claimed) return { outcome: "stale", review: first.response, policies: first.policies };

  try {
    // ── the SECOND check ─────────────────────────────────────────────────────────
    // Between the first check and the claim, someone else's upgrade can land, an admin can
    // flip a connector, or a policy can move. Re-deriving under the claim is what makes
    // "what applies is what was reviewed" true rather than probable. Still phase `claimed`:
    // no resource has been touched, so a failure here releases the claim instead of
    // recording one.
    const second = await build();
    if (second.durable.reviewHash !== input.reviewHash) {
      await releaseApplyClaim(installId, operationId, kind);
      await insertPluginAudit(db, { operationId, event: "stale", actorId: input.actorId, reviewHash: input.reviewHash, targetKey });
      return { outcome: "stale", review: second.response, policies: second.policies };
    }

    // ── mutating ─────────────────────────────────────────────────────────────────
    let manifest: Record<string, unknown>;
    try {
      await renewApplyLease(installId, operationId);
      manifest = await input.performWrites({ operationId, plan: second.plan, observations: second.observations, installId });
    } catch (e) {
      // Resources were already changed, so the operation is `failed` — not released. A
      // released claim would claim nothing happened.
      await markApplyFailed(installId, operationId);
      await insertPluginAudit(db, {
        operationId, event: "failed", actorId: input.actorId, reviewHash: input.reviewHash, targetKey,
        errorCode: e instanceof FencedWriteError ? "fenced" : "write_failed",
      });
      log.error("plugin apply failed while mutating", { installId, operationId, err: String(e) });
      return { outcome: "failed", errorCode: e instanceof FencedWriteError ? "fenced" : "write_failed" };
    }

    // ── committed ────────────────────────────────────────────────────────────────
    // Publishing the view, carrying out the dispositions and recording `succeeded` are ONE
    // transaction, and the ORDER inside it matters: finalize first, so a lost CAS aborts
    // before a single policy row is deleted.
    //
    // Doing the dispositions first and finalizing after — which is what this used to do —
    // produced a state with no honest description: the policy was already gone, the journal
    // said `succeeded`, the finalize had lost, a second `failed` event followed it, and the
    // plugin stayed invisible. Rolling back is only possible while it is all one statement
    // sequence in one transaction.
    let lostLease = false;
    try {
      await db.transaction(async (tx) => {
        if (!await finalizeApply({ installId, operationId, manifest }, tx)) {
          lostLease = true;
          // Abort so nothing else in this transaction lands. The reaper took the lease while
          // we were writing, so the resources are changed but must not be published.
          throw new Error("lease lost at finalize");
        }
        const { deleted } = await applyDispositions(tx, {
          dispositions: input.dispositions,
          baseline: second.policyBaseline,
          outlooks: second.policies,
          actor: input.actor,
        });
        // Each deletion gets the SAME `policy.clear` entry a hand edit would, carrying the
        // operation that caused it — otherwise a rule vanishes with only a plugin event to
        // explain it, and the permissions trail has a hole exactly where it matters.
        for (const row of deleted) {
          await insertPolicyClearAudit(tx, { actorId: input.actorId, operationId, row });
        }
        await insertPluginAudit(tx, { operationId, event: "succeeded", actorId: input.actorId, reviewHash: input.reviewHash, targetKey });
      });
    } catch (e) {
      const errorCode = lostLease ? "lease_lost"
        : e instanceof ForbiddenDispositionError ? "policy_forbidden"
          : "policy_stale";
      await markApplyFailed(installId, operationId);
      await insertPluginAudit(db, {
        operationId, event: "failed", actorId: input.actorId, reviewHash: input.reviewHash, targetKey, errorCode,
      });
      log.error("plugin apply failed at commit", { installId, operationId, errorCode, err: String(e) });
      return { outcome: "failed", errorCode };
    }
    return { outcome: "succeeded" };
  } catch (e) {
    // Anything unexpected between the claim and the mutation. Phase `claimed`, so the claim
    // is released rather than recorded as a failure of work that never started.
    await releaseApplyClaim(installId, operationId, kind);
    log.error("plugin apply aborted before mutating", { installId, operationId, err: String(e) });
    return { outcome: "failed", errorCode: "aborted" };
  }
}
