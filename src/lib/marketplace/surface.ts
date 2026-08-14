import type { NormalizedEndpoint } from "./canonical";

/**
 * What a plugin install reaches, in three projections with three different lifetimes
 * (docs/plugin-install-review-spec.md §4).
 *
 * The rule the whole file exists to enforce: **values never enter a durable or
 * client-visible projection** — only the NAMES of secrets, headers, env vars and query
 * parameters. There is exactly one carve-out, `EphemeralExecutionDetail`, and it is
 * stated in full at its declaration.
 */

/**
 * Parameterized over its element types rather than declared as
 * `connectors: (Stored | Public)[]`.
 *
 * With a union, a stored element carrying a fingerprint could sit inside a surface
 * being sent to a client and the type would still check — the leak would remain
 * representable. The generic makes a surface homogeneous; the `projection`
 * discriminants on the elements make the two kinds mutually unassignable.
 */
export interface InstallSurface<C, S, F> {
  schemaVersion: number;
  /**
   * How this surface was obtained, which decides whether a delta against it means
   * anything: `derived` from a plan for a known commit, `reconstructed` from an older
   * row that stored only an inventory, `unknown` when no baseline could be established.
   */
  completeness: "derived" | "reconstructed" | "unknown";
  /** Sorted by `originKey`. */
  connectors: C[];
  /** Sorted by `name`. */
  skills: S[];
  files: F;
}

/** Everything the projections share. Contains no value of any kind. */
export interface SurfaceConnectorBase {
  name: string;
  /** `<manifest path>#<server key>`. Identity WITHIN one commit: the server name IS
   *  the object key, so a rename changes it — which is why a rename gates as
   *  removal + expansion and needs no special case (§6). */
  originKey: string;
  transport: "http" | "sse" | "stdio";
  endpoint?: NormalizedEndpoint;
  /**
   * The auth kind the install would PERSIST, which is why it belongs to the surface
   * even though `detectedAuth` (an observation) is where it comes from. The two are not
   * duplicates: the observation is what the probe saw at review time, this is what
   * `upsertServer` would write to the row. A connector that now wants OAuth is a real
   * change for the user however it came about.
   */
  authKind?: "token" | "oauth";
  /** Header / env NAMES only. */
  secretKeys: string[];
  needsSecret: boolean;
  /** Always true for stdio: a bundled binary and a bare `npx` are the same threat. */
  runsThirdPartyCode: boolean;
  bundled: boolean;
  /**
   * What this side says about activation — and the two sides say different KINDS of
   * thing, which is why one shared `enabled: boolean` would be wrong.
   *
   * An artifact surface can only say `forced_disabled` or `left_as_is`:
   * `upsertServer`'s update path never touches `enabled`, so an install cannot force a
   * connector ON. It forces OFF exactly when a `${...}` placeholder is present, or for
   * every stdio server.
   *
   * A runtime surface reports the row as it actually stands, `enabled` or `disabled` —
   * whatever the user or admin last chose.
   */
  activation: "forced_disabled" | "left_as_is" | "enabled" | "disabled";
}

/**
 * Persisted in `pluginInstalls.manifest`. The execution SHAPE, never the command line:
 * enough to detect that it changed, not enough to reveal what was in it.
 */
export type StoredSurfaceConnector = SurfaceConnectorBase & {
  readonly projection: "stored";
  execution?: {
    /** argv[0] only — "npx", "node", or a path inside the plugin root. */
    binary: string;
    argCount: number;
    /** Indices of arguments carrying a `${...}` placeholder. */
    placeholderArgs: number[];
    /** Keyed HMAC over the full canonical command line. */
    fingerprint: string;
  };
};

/**
 * Sent to the client and written to the audit journal. Same as stored minus the
 * fingerprint: a keyed digest still lets someone confirm a guess about a private
 * plugin's contents, so it stays server-side even though it is not itself a secret.
 */
export type PublicSurfaceConnector = SurfaceConnectorBase & {
  readonly projection: "public";
  execution?: { binary: string; argCount: number; placeholderArgs: number[] };
  /** Which aspects differ from the baseline, filled in by the delta. */
  changed?: ("credential" | "command" | "endpoint" | "instructions")[];
};

/**
 * The ONE place a literal command line exists outside `ResolvedPluginPlan`, carried in
 * a single response to the authorized installer and nowhere else. Never persisted,
 * never audited — `insertPluginAudit` accepts only a durable review, so the
 * persistence half is unrepresentable rather than merely forbidden.
 *
 * The reason for the exception: a command line is the SUBJECT of the review. Redacting
 * it would leave the installer consenting to something they cannot read. Nothing else
 * may claim this.
 */
export interface EphemeralExecutionDetail {
  connectorName: string;
  command: string;
  args: string[];
}

/** A hash is a confirmation oracle, so skills split the same way connectors do. */
export interface StoredSurfaceSkill {
  readonly projection: "stored";
  name: string;
  originPath: string;
  instructionHash: string;
  filesRootHash: string;
}

export interface PublicSurfaceSkill {
  readonly projection: "public";
  name: string;
  originPath: string;
  changed?: ("instructions" | "files")[];
}

export interface StoredSurfaceFile {
  path: string;
  bytes: number;
  contentHash: string;
}

export interface StoredSurfaceFiles {
  readonly projection: "stored";
  count: number;
  bytes: number;
  rootHash: string;
  /** Reflects reality: `plugin-runtime.ts` makes exactly one path executable —
   *  `spec.command`, and only when it points inside the plugin root. */
  entrypoints: string[];
  files: StoredSurfaceFile[];
}

export interface PublicSurfaceFiles {
  readonly projection: "public";
  count: number;
  bytes: number;
  entrypoints: string[];
  changedPaths?: string[];
  addedPaths?: string[];
  removedPaths?: string[];
}

export type StoredInstallSurface = InstallSurface<StoredSurfaceConnector, StoredSurfaceSkill, StoredSurfaceFiles>;
export type PublicInstallSurface = InstallSurface<PublicSurfaceConnector, PublicSurfaceSkill, PublicSurfaceFiles>;

/** Bumped when the surface's own shape changes, so an old stored surface is detectable
 *  rather than silently misread. */
export const SURFACE_SCHEMA_VERSION = 1;
