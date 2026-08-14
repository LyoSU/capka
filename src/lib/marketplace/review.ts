import { contentHash, canonicalTypedValue, type CanonValue } from "./canonical";
import type { InstallDelta } from "./delta";
import type { ApplyKind } from "./manifest-store";
import type { ReviewObservations } from "./observe";
import type { ResolvedPluginPlan } from "./plan";
import { ephemeralExecutionDetails, toPublicSurface } from "./project";
import type { EphemeralExecutionDetail, PublicInstallSurface, StoredInstallSurface } from "./surface";

/**
 * The consented artifact (docs/plugin-install-review-spec.md §3 invariant 6, §10).
 *
 * `reviewHash` covers EVERY input the decision depends on. Anything left out is a way for
 * the thing that applies to differ from the thing that was reviewed — which is the one
 * property this whole feature exists to provide.
 */

export type PolicyDisposition = "keep" | "delete" | "reassign";

/** What the installer is being asked to accept, identity included. */
export interface ReviewSubject {
  kind: ApplyKind;
  installId: string | null;
  marketplaceId: string;
  pluginName: string;
  scope: "system" | "user";
  ownerId: string | null;
  targetSha: string;
  /** `--skill` narrowing. Part of the hash: a review of two skills must not authorize
   *  an apply of twenty. */
  only: string[] | null;
}

/** Ephemeral — to the authorized installer, in one response, never persisted. */
export interface ReviewResponse {
  subject: ReviewSubject;
  reviewHash: string;
  surface: PublicInstallSurface;
  delta: InstallDelta;
  gate: InstallDelta["gate"];
  /** Per-connector preflight verdicts and the policy they were computed under. */
  observations: ReviewObservations;
  notes: string[];
  /** The ONE place a literal command line leaves the plan. See
   *  `EphemeralExecutionDetail` for why this exception exists at all. */
  execution: EphemeralExecutionDetail[];
}

/**
 * The audit payload. A SEPARATE type, not a subset by convention: `insertPluginAudit`
 * accepts only this, so the literal command line cannot reach the journal by accident —
 * the persistence half is unrepresentable rather than merely forbidden.
 */
export interface DurablePluginReview {
  subject: ReviewSubject;
  reviewHash: string;
  surface: PublicInstallSurface;
  delta: InstallDelta;
  gate: InstallDelta["gate"];
  observations: ReviewObservations;
  notes: string[];
}

/**
 * A surface reduced to the fields a decision turns on.
 *
 * Written as an explicit projection rather than hashing the whole object, because the
 * surface carries display-adjacent data that must NOT invalidate a consent: adding a
 * field for the UI later should not silently expire every outstanding review.
 */
function hashableSurface(s: StoredInstallSurface | null): CanonValue {
  if (!s) return null;
  return {
    completeness: s.completeness,
    connectors: s.connectors.map((c) => ({
      originKey: c.originKey, name: c.name, transport: c.transport,
      endpoint: c.endpoint ? { ...c.endpoint, queryKeys: [...c.endpoint.queryKeys] } : null,
      authKind: c.authKind ?? null,
      secretKeys: [...c.secretKeys], needsSecret: c.needsSecret,
      runsThirdPartyCode: c.runsThirdPartyCode, bundled: c.bundled, activation: c.activation,
      execution: c.execution
        ? { binary: c.execution.binary, argCount: c.execution.argCount,
            placeholderArgs: [...c.execution.placeholderArgs], fingerprint: c.execution.fingerprint }
        : null,
    })),
    skills: s.skills.map((k) => ({ name: k.name, originPath: k.originPath, instructionHash: k.instructionHash, filesRootHash: k.filesRootHash })),
    files: { count: s.files.count, bytes: s.files.bytes, rootHash: s.files.rootHash, entrypoints: [...s.files.entrypoints] },
  };
}

/**
 * Bind a decision to everything it depends on.
 *
 * The subject is in the hash so a review accepted for one install cannot be replayed
 * against another — same plugin, different scope or owner, is a different decision.
 *
 * The observations are in it too, but only the parts a decision turns on: the URL
 * verdicts, the applied auth kinds and the private-range policy. `observedAt` is
 * deliberately EXCLUDED — a review must not expire merely because time passed, and
 * including a timestamp would make every hash unreproducible by construction.
 *
 * Notes are excluded because they are prose, some of it localized: a copy edit must not
 * revoke a consent.
 */
export function reviewHash(input: {
  subject: ReviewSubject;
  sourceBefore: StoredInstallSurface | null;
  runtimeBefore: StoredInstallSurface | null;
  sourceAfter: StoredInstallSurface;
  observations: ReviewObservations;
  /** Policy key → what the installer agreed should happen to it. Part of the hash, so
   *  the installer cannot consent to one policy outcome and have another applied. */
  dispositions: Record<string, PolicyDisposition>;
  /** `(scope, capabilityType, capabilityKey, userId, projectId)` → its `revision`, for
   *  every policy row a disposition touches. The policy tables are not plugin-owned, so
   *  the apply-state fence does not cover a hand edit; a WIDER BASELINE covers it
   *  instead. A concurrent policy change then stops being a special case and becomes a
   *  stale baseline, caught by the second hash check like any other. */
  policyRevisions: Record<string, number>;
}): string {
  return contentHash(canonicalTypedValue("review", {
    v: 1,
    subject: {
      kind: input.subject.kind, installId: input.subject.installId,
      marketplaceId: input.subject.marketplaceId, pluginName: input.subject.pluginName,
      scope: input.subject.scope, ownerId: input.subject.ownerId,
      targetSha: input.subject.targetSha,
      only: input.subject.only ? [...input.subject.only].sort() : null,
    },
    sourceBefore: hashableSurface(input.sourceBefore),
    runtimeBefore: hashableSurface(input.runtimeBefore),
    sourceAfter: hashableSurface(input.sourceAfter),
    observations: {
      urls: input.observations.urls as unknown as CanonValue,
      detectedAuth: input.observations.detectedAuth as unknown as CanonValue,
      blockPrivate: input.observations.policy.blockPrivate,
    },
    dispositions: input.dispositions as unknown as CanonValue,
    policyRevisions: input.policyRevisions as unknown as CanonValue,
  }));
}

/**
 * Build the three projections of one review at once, so they cannot disagree.
 *
 * The return shape is the type boundary that makes the redaction rule structural: the
 * ephemeral response carries literal command lines, `durable` cannot represent them, and
 * `storedAfter` is the next baseline. A caller has to choose which one it is handling.
 */
export function projectPluginReview(input: {
  subject: ReviewSubject;
  plan: ResolvedPluginPlan;
  observations: ReviewObservations;
  sourceBefore: StoredInstallSurface | null;
  runtimeBefore: StoredInstallSurface | null;
  sourceAfter: StoredInstallSurface;
  delta: InstallDelta;
  dispositions: Record<string, PolicyDisposition>;
  policyRevisions: Record<string, number>;
}): { response: ReviewResponse; durable: DurablePluginReview; storedAfter: StoredInstallSurface } {
  const hash = reviewHash({
    subject: input.subject,
    sourceBefore: input.sourceBefore,
    runtimeBefore: input.runtimeBefore,
    sourceAfter: input.sourceAfter,
    observations: input.observations,
    dispositions: input.dispositions,
    policyRevisions: input.policyRevisions,
  });
  const surface = toPublicSurface(input.sourceAfter);
  const durable: DurablePluginReview = {
    subject: input.subject, reviewHash: hash, surface, delta: input.delta,
    gate: input.delta.gate, observations: input.observations, notes: input.plan.notes,
  };
  return {
    response: { ...durable, execution: ephemeralExecutionDetails(input.plan) },
    durable,
    storedAfter: input.sourceAfter,
  };
}
