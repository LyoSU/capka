import { canonicalTypedValue } from "./canonical";
import type { UrlVerdict } from "@/lib/net/ssrf";
import type { StoredInstallSurface, StoredSurfaceConnector, StoredSurfaceSkill } from "./surface";

/**
 * What changes between two surfaces, and whether it needs consent
 * (docs/plugin-install-review-spec.md §6).
 *
 * The classes partition by **identity**, so no change falls into two of them: what
 * changed about a resource that still exists is always a `replacement`, and `expansion`
 * is reserved for a resource appearing. An earlier formulation keyed on the nature of
 * the change instead and put a removed resource under both `attenuation` and `removal`.
 */
export type DeltaKind = "unchanged" | "removal" | "expansion" | "attenuation" | "replacement" | "unknown";

export type DeltaAspect = "credential" | "command" | "endpoint" | "instructions" | "files" | "activation";

export interface DeltaEntry {
  resource: "connector" | "skill" | "files";
  /** `originKey` for a connector, `name` for a skill, `"files"` for the bundled tree. */
  key: string;
  /** The display name, which for a connector is also its policy key. */
  name: string;
  kind: DeltaKind;
  /** Which aspects differ. Empty for `unchanged`, `removal` and `expansion` — there is
   *  no per-aspect comparison to make when one side does not exist. */
  aspects: DeltaAspect[];
}

export interface InstallDelta {
  /** `sourceBefore → sourceAfter`: what the author changed. */
  upstream: DeltaEntry[];
  /** `runtimeBefore → sourceAfter`: what applying would overwrite. The gate reads this
   *  one; `upstream` is surfaced only when the two differ. */
  effective: DeltaEntry[];
  /** The SET of classes present, not an ordinal — "the worst kind" is not a
   *  well-defined idea when a single upgrade both removes and expands. */
  kinds: DeltaKind[];
  gate: "no_consent" | "requires_consent" | "cannot_apply";
}

/**
 * The comparable form of a connector: everything whose change is a change to what the
 * connector reaches or runs.
 *
 * `activation` is deliberately EXCLUDED here and compared separately — it is the one
 * field where the two sides say different kinds of thing (an artifact says what the
 * install would force, a runtime row says what the user chose), so folding it in would
 * make every enabled connector look replaced.
 */
function connectorIdentity(c: StoredSurfaceConnector): string {
  return canonicalTypedValue("connector", {
    transport: c.transport,
    endpoint: c.endpoint ? { ...c.endpoint, queryKeys: [...c.endpoint.queryKeys] } : null,
    authKind: c.authKind ?? null,
    // The endpoint above is redacted, so this digest is the ONLY thing that can see a
    // changed token, query value or URL password. Omitting it made those `unchanged`.
    credentialFingerprint: c.credentialFingerprint ?? null,
    secretKeys: [...c.secretKeys],
    needsSecret: c.needsSecret,
    runsThirdPartyCode: c.runsThirdPartyCode,
    bundled: c.bundled,
    execution: c.execution
      ? { binary: c.execution.binary, argCount: c.execution.argCount,
          placeholderArgs: [...c.execution.placeholderArgs], fingerprint: c.execution.fingerprint }
      : null,
  });
}

function connectorAspects(before: StoredSurfaceConnector, after: StoredSurfaceConnector): DeltaAspect[] {
  const aspects: DeltaAspect[] = [];
  // `needsSecret` true → false lands here, and the ambiguity is the point: it may mean
  // the plugin dropped a feature that needed the key, or that it now reaches the same
  // endpoint without one. "Fewer" is not "weaker", so it is a replacement to be read,
  // never a reduction to wave through.
  if (before.needsSecret !== after.needsSecret
    || canonicalTypedValue("k", [...before.secretKeys]) !== canonicalTypedValue("k", [...after.secretKeys])
    || (before.authKind ?? null) !== (after.authKind ?? null)
    // A value change under an unchanged NAME is only visible here.
    || (before.credentialFingerprint ?? null) !== (after.credentialFingerprint ?? null)) aspects.push("credential");
  if (canonicalTypedValue("e", before.execution ? { ...before.execution, placeholderArgs: [...before.execution.placeholderArgs] } : null)
    !== canonicalTypedValue("e", after.execution ? { ...after.execution, placeholderArgs: [...after.execution.placeholderArgs] } : null)) aspects.push("command");
  if (canonicalTypedValue("p", before.endpoint ? { ...before.endpoint, queryKeys: [...before.endpoint.queryKeys] } : null)
    !== canonicalTypedValue("p", after.endpoint ? { ...after.endpoint, queryKeys: [...after.endpoint.queryKeys] } : null)
    || before.transport !== after.transport) aspects.push("endpoint");
  return aspects;
}

function skillAspects(before: StoredSurfaceSkill, after: StoredSurfaceSkill): DeltaAspect[] {
  const aspects: DeltaAspect[] = [];
  // Both hashes: `instructionHash` catches what the author changed (raw file, frontmatter
  // included), `bodyHash` catches what the ROW says — which is how a hand-edited or
  // prompt-injected skill body in the database becomes visible at all.
  if (before.instructionHash !== after.instructionHash
    || before.bodyHash !== after.bodyHash
    || before.originPath !== after.originPath) aspects.push("instructions");
  if (before.filesRootHash !== after.filesRootHash) aspects.push("files");
  return aspects;
}

/**
 * Compare one axis. `before` may be null, which is the `unknown` case: no baseline could
 * be established (a legacy row that stored only an inventory, or a pinned commit that
 * has gone from upstream). `unknown` requires consent — an unverifiable change is not
 * the same as no change.
 */
function compareAxis(before: StoredInstallSurface | null, after: StoredInstallSurface): DeltaEntry[] {
  if (!before || before.completeness === "unknown") {
    return [
      ...after.connectors.map((c): DeltaEntry => ({ resource: "connector", key: c.originKey, name: c.name, kind: "unknown", aspects: [] })),
      ...after.skills.map((s): DeltaEntry => ({ resource: "skill", key: s.name, name: s.name, kind: "unknown", aspects: [] })),
      ...(after.files.count ? [{ resource: "files" as const, key: "files", name: "files", kind: "unknown" as const, aspects: [] }] : []),
    ];
  }

  const entries: DeltaEntry[] = [];
  const beforeConnectors = new Map(before.connectors.map((c) => [c.originKey, c]));
  const afterConnectors = new Map(after.connectors.map((c) => [c.originKey, c]));

  for (const [key, a] of afterConnectors) {
    const b = beforeConnectors.get(key);
    if (!b) { entries.push({ resource: "connector", key, name: a.name, kind: "expansion", aspects: [] }); continue; }
    const same = connectorIdentity(b) === connectorIdentity(a);
    // Attenuation is narrow ON PURPOSE: the resource must be otherwise byte-identical,
    // the baseline must say it is actually enabled right now, and the artifact must
    // force it off. Anything else is a replacement, because a change that also reduces
    // something is still a change the installer has to read.
    if (same && b.activation === "enabled" && a.activation === "forced_disabled") {
      entries.push({ resource: "connector", key, name: a.name, kind: "attenuation", aspects: ["activation"] });
    } else if (same) {
      entries.push({ resource: "connector", key, name: a.name, kind: "unchanged", aspects: [] });
    } else {
      entries.push({ resource: "connector", key, name: a.name, kind: "replacement", aspects: connectorAspects(b, a) });
    }
  }
  for (const [key, b] of beforeConnectors) {
    if (!afterConnectors.has(key)) entries.push({ resource: "connector", key, name: b.name, kind: "removal", aspects: [] });
  }

  const beforeSkills = new Map(before.skills.map((s) => [s.name, s]));
  const afterSkills = new Map(after.skills.map((s) => [s.name, s]));
  for (const [key, a] of afterSkills) {
    const b = beforeSkills.get(key);
    if (!b) { entries.push({ resource: "skill", key, name: a.name, kind: "expansion", aspects: [] }); continue; }
    const aspects = skillAspects(b, a);
    entries.push({ resource: "skill", key, name: a.name, kind: aspects.length ? "replacement" : "unchanged", aspects });
  }
  for (const [key, b] of beforeSkills) {
    if (!afterSkills.has(key)) entries.push({ resource: "skill", key, name: b.name, kind: "removal", aspects: [] });
  }

  // Two empty trees are the same tree, whatever placeholder each side's `rootHash`
  // holds — a reconstructed baseline need not have computed it the same way, and a
  // spurious "files removed" row in a consent screen teaches the reader to ignore rows.
  if (before.files.count === 0 && after.files.count === 0) {
    /* nothing to report */
  } else if (before.files.rootHash !== after.files.rootHash) {
    const kind = after.files.count === 0 ? "removal" : before.files.count === 0 ? "expansion" : "replacement";
    entries.push({ resource: "files", key: "files", name: "files", kind, aspects: kind === "replacement" ? ["files"] : [] });
  } else if (after.files.count) {
    entries.push({ resource: "files", key: "files", name: "files", kind: "unchanged", aspects: [] });
  }

  // Sorted so a delta for one pair of surfaces is stable: it is hashed as part of the
  // consented artifact, and an unstable order would invalidate a valid review.
  return entries.sort((x, y) => `${x.resource} ${x.key}` < `${y.resource} ${y.key}` ? -1
    : `${x.resource} ${x.key}` > `${y.resource} ${y.key}` ? 1 : 0);
}

const CONSENT_FREE: ReadonlySet<DeltaKind> = new Set<DeltaKind>(["unchanged", "removal", "attenuation"]);

export function classifyDelta(input: {
  sourceBefore: StoredInstallSurface | null;
  runtimeBefore: StoredInstallSurface | null;
  sourceAfter: StoredInstallSurface;
  /** Per-connector preflight verdicts from the observation. Any refusal is
   *  `cannot_apply` regardless of what changed. */
  urls: Record<string, UrlVerdict>;
}): InstallDelta {
  const upstream = compareAxis(input.sourceBefore, input.sourceAfter);
  const effective = compareAxis(input.runtimeBefore, input.sourceAfter);
  const kinds = [...new Set(effective.map((e) => e.kind))];

  // A valid consent does not override an inability to proceed: DNS may have turned
  // unsafe since the review, which is not a different decision to make but a reason
  // there is nothing safe to apply.
  const unsafe = Object.values(input.urls).some((v) => v !== "allowed");
  const gate = unsafe ? "cannot_apply"
    : kinds.some((k) => !CONSENT_FREE.has(k)) ? "requires_consent"
      : "no_consent";

  return { upstream, effective, kinds, gate };
}
