import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls } from "@/lib/db/schema";
import { getBlockPrivateProviderUrls, getMasterKey } from "@/lib/settings";
import { log } from "@/lib/log";
import { insertPluginAudit, insertPolicyClearAudit } from "./audit";
import { classifyDelta } from "./delta";
import { FencedWriteError } from "./fence";
import { readStoredManifest, reservedManifest, type ApplyKind } from "./manifest-store";
import { observePluginPlan } from "./observe";
import {
  APPLY_LEASE_SECONDS, claimApply, finalizeApply, markApplyFailed, releaseApplyClaim, renewApplyLease,
  type ApplyPhase,
} from "./operation";
import { buildPluginPlan } from "./plan";
import {
  ForbiddenDispositionError, analysePolicies, applyDispositions, foreignSurvivors, policyRevisions,
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

/**
 * Whether a failed INSERT means "someone else got here first" — and nothing else does.
 *
 * The staging insert used to treat EVERY exception as a conflict, which reported an FK
 * violation (the marketplace was deleted mid-request), a check constraint, or a
 * serialization failure back to the caller as a routine 409 with a fresh review. That is a
 * false diagnosis, and it puts a real fault behind a retry prompt where nothing gets logged
 * and the retry cannot possibly work.
 *
 * Drizzle wraps driver errors from v0.36 on, keeping the pg error as `cause`; older versions
 * reject with it directly. Both are checked rather than pinning a version.
 */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  return code === "23505";
}

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

/**
 * What the REVIEW calls this operation — which is not always what the apply calls it.
 *
 * `kind` is inside `reviewHash`, so the preview and the accept must derive it identically or
 * every retry would come back `stale` and no first install could ever be finished. A retry
 * is an install that has not happened yet, and the person is consenting to exactly the
 * install they consented to before, so the subject says `install`. The apply's own
 * `ApplyKind` is a different question — it decides which undo a released claim owes — and
 * that one does distinguish the retry.
 */
function subjectKind(installId: string | null, storedManifestRaw: unknown): ApplyKind {
  return installId === null || readStoredManifest(storedManifestRaw).neverCommitted ? "install" : "upgrade";
}

/** Everything a review needs, gathered fresh. Used identically by the preview and by the
 *  apply, so the two cannot compute a different picture from the same inputs. */
async function gather(input: {
  gh: { owner: string; repo: string; ref: string; subdir: string };
  subject: ReviewSubject;
  installId: string | null;
  storedManifestRaw: unknown;
  /** Whose authority the policy outlooks are computed against — the asker's, never the
   *  install's: a personal install may name an org-wide rule in its baseline. */
  actor: DispositionActor;
}) {
  const keyHex = await getMasterKey();
  const plan = await buildPluginPlan(input.gh, { only: input.subject.only ?? undefined });
  const observations = await observePluginPlan(plan, { blockPrivate: await getBlockPrivateProviderUrls() });
  const sourceAfter = projectPlanSurface(plan, observations, keyHex);

  const stored = readStoredManifest(input.storedManifestRaw);
  // A first install's baseline is EMPTY, not unknown: nothing existed, which is a known
  // fact and makes every resource an `expansion`. A legacy row's baseline is genuinely
  // unknown — it stored no surface — and `null` is what the delta reads as `unknown`.
  //
  // A staging row whose install never committed is the FIRST case, not the second, even
  // though it has an id: nothing was ever published, so the baseline is empty for the same
  // reason. `committedRevision` alone cannot tell the two apart (both read 0), which is why
  // the reader reports `neverCommitted` separately — conflating them made every retry of a
  // failed first install read as an `unknown` replacement of resources that do not exist.
  const isFirst = input.installId === null || stored.neverCommitted;
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
  // What survives is not "what this plan still declares" but "what ANY resource of that name
  // still answers to". A policy is keyed on (type, name) alone, so a rule is orphaned only when
  // nothing of that name remains anywhere — not merely when this plugin stops declaring it.
  const policies = analysePolicies({
    affected: policyBaseline,
    survivingNames: [
      ...sourceAfter.connectors.map((c) => ({ type: "connector" as const, name: c.name })),
      ...sourceAfter.skills.map((s) => ({ type: "skill" as const, name: s.name })),
      ...await foreignSurvivors(
        policyBaseline.map((r) => ({ type: r.capabilityType, name: r.capabilityKey })),
        input.installId ? `catalog:${input.installId}` : null,
      ),
    ],
    actor: input.actor,
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
  /** Decides which policy rules this reader is told they may delete. */
  actor: DispositionActor;
}): Promise<{ review: ReviewResponse; policies: PolicyOutlook[] }> {
  const subject: ReviewSubject = {
    kind: subjectKind(input.installId, input.storedManifestRaw),
    installId: input.installId, marketplaceId: input.marketplaceId, pluginName: input.pluginName,
    scope: input.scope, ownerId: input.ownerId, targetSha: input.targetSha,
    only: input.only?.length ? input.only : null,
  };
  const g = await gather({
    gh: input.gh, subject, installId: input.installId,
    storedManifestRaw: input.storedManifestRaw, actor: input.actor,
  });
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

  const row = input.installId
    ? (await db.select({ manifest: pluginInstalls.manifest }).from(pluginInstalls).where(eq(pluginInstalls.id, input.installId)).limit(1))[0]
    : undefined;

  // Three kinds, because `releaseApplyClaim` owes each a different undo — and only the
  // claim can say which, since a staging row and a claimed ready install are the same shape
  // once `applyState` is set. `retry` was declared and handled there but never PRODUCED:
  // every apply naming an existing row was recorded as an upgrade, so giving back a retry's
  // claim cleared `applyState` outright and a first install that never committed came back
  // looking like a healthy, empty plugin instead of one still needing attention.
  const kind: ApplyKind = input.installId === null
    ? "install"
    : readStoredManifest(row?.manifest).neverCommitted ? "retry" : "upgrade";
  const subject: ReviewSubject = {
    kind: subjectKind(input.installId, row?.manifest), installId: input.installId,
    marketplaceId: input.marketplaceId, pluginName: input.pluginName,
    scope: input.scope, ownerId: input.ownerId, targetSha: input.targetSha,
    only: input.only?.length ? input.only : null,
  };

  const build = async () => {
    const g = await gather({ gh: input.gh, subject, installId: input.installId, storedManifestRaw: row?.manifest, actor: input.actor });
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
            // Through `reservedManifest`, not a literal: the reader discriminates on
            // `schemaVersion`, and a second hand-written copy of this shape is how one of them
            // quietly starts reading as a legacy row.
            manifest: reservedManifest(stagedApplyState) as unknown as Record<string, unknown>,
          });
        } catch (e) {
          // Someone else's first install won the unique index. Theirs is in flight; ours is
          // stale. The transaction is aborted by the constraint, so nothing is stranded.
          if (!isUniqueViolation(e)) throw e;
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

  /**
   * Record that this apply ended badly — but only when the flip to `failed` was OURS to make.
   *
   * `markApplyFailed` is a compare-and-set, and losing it means something else already ended
   * this operation: the reaper took the expired lease and has already written `lease_expired`
   * under the SAME deterministic event id. Writing ours as well produced two different
   * terminal payloads for one operation, and whichever landed first decided what the history
   * said while the other threw an invariant violation out of a `catch` block — which then fell
   * through to the outer handler and RELEASED a claim after resources had already changed.
   *
   * Winning the transition is the authority to describe the outcome, exactly as it is the
   * authority to write a resource. Same rule as the P0, applied to the journal.
   */
  const recordTerminalFailure = async (errorCode: string): Promise<void> => {
    if (!await markApplyFailed(installId, operationId)) return;
    await insertPluginAudit(db, {
      operationId, event: "failed", actorId: input.actorId, reviewHash: input.reviewHash, targetKey, errorCode,
    });
  };

  // Which `catch` is allowed to do what, decided by WHERE we are rather than by what was
  // thrown. Only `claimed` may release: a release past that point would claim nothing
  // happened, and resources had already moved.
  let phase: ApplyPhase = "claimed";

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
    phase = "mutating";
    try {
      await renewApplyLease(installId, operationId);
      manifest = await input.performWrites({ operationId, plan: second.plan, observations: second.observations, installId });
    } catch (e) {
      // Resources were already changed, so the operation is `failed` — not released. A
      // released claim would claim nothing happened.
      const errorCode = e instanceof FencedWriteError ? "fenced" : "write_failed";
      await recordTerminalFailure(errorCode);
      log.error("plugin apply failed while mutating", { installId, operationId, err: String(e) });
      return { outcome: "failed", errorCode };
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
      // `lostLease` is precisely the case where the flip is NOT ours: the reaper already
      // holds this operation and has already named the outcome `lease_expired`. So this
      // writes nothing, which is correct — the history has one terminal event, from the
      // writer that earned it.
      await recordTerminalFailure(errorCode);
      log.error("plugin apply failed at commit", { installId, operationId, errorCode, err: String(e) });
      return { outcome: "failed", errorCode };
    }
    return { outcome: "succeeded" };
  } catch (e) {
    // Anything unexpected. WHERE it happened decides what may be done about it: at `claimed`
    // nothing has been touched, so the claim is released rather than recorded as a failure of
    // work that never started. Past that, resources have moved and releasing would say the
    // opposite of what is true — so the claim is recorded as failed instead. Reaching here
    // from `mutating` at all means one of the inner handlers threw, which is why this branch
    // can no longer just release.
    if (phase === "claimed") await releaseApplyClaim(installId, operationId, kind);
    else await recordTerminalFailure("aborted");
    log.error("plugin apply aborted", { installId, operationId, phase, err: String(e) });
    return { outcome: "failed", errorCode: "aborted" };
  }
}
