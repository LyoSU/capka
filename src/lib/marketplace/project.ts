import { fingerprint } from "@/lib/crypto";
import { inferRemoteTransport } from "@/lib/mcp/types";
import { canonicalTypedValue, contentHash, normalizeEndpoint, rootHash } from "./canonical";
import type { ReviewObservations } from "./observe";
import { substituteServerSpec } from "./plugin-root";
import type { PlannedConnector, PlannedSkill, ResolvedPluginPlan } from "./plan";
import {
  SURFACE_SCHEMA_VERSION,
  type EphemeralExecutionDetail, type PublicInstallSurface, type PublicSurfaceConnector,
  type PublicSurfaceSkill, type StoredInstallSurface, type StoredSurfaceConnector,
  type StoredSurfaceSkill,
} from "./surface";

/**
 * Turning a plan into the projections a review is built from
 * (docs/plugin-install-review-spec.md §4).
 *
 * The direction is one-way: a plan (which holds real values) becomes a stored surface
 * (shapes and keyed digests), which becomes a public surface (names only). Nothing
 * reads back the other way, which is what keeps a value from arriving somewhere it
 * must not be.
 */

/** A path the sandbox would make executable, or null. */
function entrypointOf(command: string): string | null {
  // Mirrors `plugin-runtime.ts` exactly rather than re-deriving it: that file
  // substitutes the placeholders and then chmods `spec.command` if and only if it
  // landed inside the plugin base dir. Re-implementing the placeholder rules here
  // would let the two drift, and the surface would then claim a different entrypoint
  // than the one that actually becomes executable.
  const sentinel = "/__plugin_root__";
  const spec = substituteServerSpec({ command }, sentinel);
  return spec.command.startsWith(`${sentinel}/`) ? spec.command.slice(sentinel.length + 1) : null;
}

const HAS_PLACEHOLDER = /\$\{[^}]+\}/;

function projectConnector(c: PlannedConnector, obs: ReviewObservations, keyHex: string): StoredSurfaceConnector {
  const stdio = c.kind === "stdio";
  // `secretKeys` lists the NAMED INPUTS this connector reads — header names for a
  // remote endpoint, env keys for a local one. Not every one is a credential
  // (`NODE_ENV` is not), which is what `needsSecret` distinguishes: whether the
  // operator has to supply a value before the connector can work.
  const secretKeys = (stdio ? Object.keys(c.env ?? {}) : Object.keys(c.headers ?? {})).sort();
  const base = {
    name: c.name,
    originKey: c.originKey,
    secretKeys,
    needsSecret: stdio ? c.envUnresolved : c.hasPlaceholder,
    // Always true for stdio: a bundled binary and a bare `npx` that fetches and runs a
    // remote package are the same threat, so the surface does not distinguish them.
    runsThirdPartyCode: stdio,
    bundled: c.bundled,
    // An artifact surface can only ever force OFF or leave alone — `upsertServer`'s
    // update path never touches `enabled`, so an install cannot force one ON. Mirrors
    // `applyPlanResources`: every stdio server, and any remote one carrying a
    // placeholder, is installed disabled.
    activation: (stdio || c.hasPlaceholder ? "forced_disabled" : "left_as_is") as "forced_disabled" | "left_as_is",
  };

  if (stdio) {
    const args = c.args ?? [];
    return {
      projection: "stored", ...base, transport: "stdio",
      execution: {
        // argv[0] only. The rest of the command line survives as a count, the indices
        // that carry a placeholder, and one keyed digest — enough to see that it
        // changed, not enough to reveal what it said.
        binary: c.command ?? "",
        argCount: args.length,
        placeholderArgs: args.flatMap((a, i) => (HAS_PLACEHOLDER.test(a) ? [i] : [])),
        fingerprint: fingerprint(
          canonicalTypedValue("execution", { command: c.command ?? "", args, env: c.env ?? {} }), keyHex),
      },
    };
  }

  return {
    projection: "stored", ...base,
    transport: c.url ? inferRemoteTransport(c.url) : "http",
    ...(c.url ? { endpoint: normalizeEndpoint(c.url) ?? undefined } : {}),
    // Over the RAW url and headers, values and all — the endpoint above is redacted, so
    // without this a changed token, query value or URL password reads as no change at all.
    credentialFingerprint: fingerprint(
      canonicalTypedValue("credential", { url: c.url ?? "", headers: c.headers ?? {} }), keyHex),
    // The APPLIED value, matching what `applyPlanResources` writes to the row — which
    // is why it belongs to the surface even though the probe that produced it is an
    // observation.
    authKind: obs.detectedAuth[c.name] ?? "token",
  };
}

function projectSkill(s: PlannedSkill): StoredSurfaceSkill {
  return {
    projection: "stored", name: s.name, originPath: s.originPath,
    instructionHash: contentHash(s.raw),
    // The same quantity the ROW will hold, so `readRuntimeSurface` can compute it for real
    // instead of copying this artifact's value back and hiding a local edit.
    bodyHash: contentHash(s.parsed.body),
    filesRootHash: rootHash(s.files.map((f) => ({ path: f.path, contentHash: contentHash(Buffer.from(f.content, "base64")) }))),
  };
}

/**
 * The artifact surface an install WOULD produce — the `sourceAfter` side of every
 * comparison, and the next baseline once it commits.
 *
 * Sorted by `originKey` / `name` so two projections of one plan are byte-identical:
 * the stored surface is compared against, and an unstable order would read as a change.
 */
export function projectPlanSurface(
  plan: ResolvedPluginPlan,
  obs: ReviewObservations,
  keyHex: string,
): StoredInstallSurface {
  const files = plan.files.map((f) => {
    const bytes = Buffer.from(f.content, "base64");
    return { path: f.path, bytes: bytes.byteLength, contentHash: contentHash(bytes) };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const entrypoints = [...new Set(plan.connectors
    .filter((c) => c.kind === "stdio" && c.command)
    .map((c) => entrypointOf(c.command!))
    .filter((p): p is string => p != null))].sort();

  return {
    schemaVersion: SURFACE_SCHEMA_VERSION,
    completeness: "derived",
    connectors: plan.connectors.map((c) => projectConnector(c, obs, keyHex))
      .sort((a, b) => (a.originKey < b.originKey ? -1 : a.originKey > b.originKey ? 1 : 0)),
    skills: plan.skills.map(projectSkill)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    files: {
      projection: "stored",
      count: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      rootHash: rootHash(files),
      entrypoints,
      files,
    },
  };
}

/**
 * The client- and audit-facing view: the stored surface minus every hash.
 *
 * A digest is not a secret, but it IS a confirmation oracle — it lets someone who
 * guesses a private plugin's command line verify the guess — so it stays server-side.
 * Written as an explicit field list rather than a delete-these-keys pass, so a field
 * added to the stored surface later does not reach the client by default.
 */
export function toPublicSurface(stored: StoredInstallSurface): PublicInstallSurface {
  return {
    schemaVersion: stored.schemaVersion,
    completeness: stored.completeness,
    connectors: stored.connectors.map((c): PublicSurfaceConnector => ({
      projection: "public",
      name: c.name, originKey: c.originKey, transport: c.transport,
      ...(c.endpoint ? { endpoint: c.endpoint } : {}),
      ...(c.authKind ? { authKind: c.authKind } : {}),
      secretKeys: c.secretKeys, needsSecret: c.needsSecret,
      runsThirdPartyCode: c.runsThirdPartyCode, bundled: c.bundled, activation: c.activation,
      ...(c.execution
        ? { execution: { binary: c.execution.binary, argCount: c.execution.argCount, placeholderArgs: c.execution.placeholderArgs } }
        : {}),
    })),
    skills: stored.skills.map((s): PublicSurfaceSkill => ({
      projection: "public", name: s.name, originPath: s.originPath,
    })),
    files: {
      projection: "public",
      count: stored.files.count, bytes: stored.files.bytes, entrypoints: stored.files.entrypoints,
    },
  };
}

/**
 * The literal command lines, for the authorized installer's expander and nowhere else.
 *
 * Separate from the surface by construction: a caller has to ask for these explicitly,
 * so they cannot ride along into a projection that gets stored or audited. See
 * `EphemeralExecutionDetail` for why this exception exists at all.
 */
export function ephemeralExecutionDetails(plan: ResolvedPluginPlan): EphemeralExecutionDetail[] {
  return plan.connectors
    .filter((c) => c.kind === "stdio" && c.command)
    .map((c) => ({ connectorName: c.name, command: c.command!, args: c.args ?? [] }));
}
