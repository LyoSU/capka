import type { StoredInstallSurface } from "./surface";
import type { InstallManifest } from "./types";

/**
 * The one way to read `pluginInstalls.manifest`
 * (docs/plugin-install-review-spec.md §4).
 *
 * The column is `jsonb`, typed `Record<string, unknown>`, so a shape change is
 * invisible to the compiler — nothing would break at build time if a reader kept
 * expecting the old layout, it would just render blanks. Hence a single reader and a
 * discriminator: a legacy row is recognized by the ABSENCE of `schemaVersion`.
 */

/** Which release applies if a claim has to be given back. The row cannot infer it —
 *  a staging row and a claimed ready install look identical once `applyState` is
 *  set — so the claim records it (§7). */
export type ApplyKind = "install" | "upgrade" | "retry";

export interface ApplyState {
  operationId: string;
  targetSha: string;
  status: "applying" | "failed";
  kind: ApplyKind;
  startedAt: string;
  leaseExpiresAt: string;
}

export interface StoredPluginManifestV2 {
  schemaVersion: 2;
  /** Last committed inventory — what the plugins UI, audit and `pruneRemoved` read. */
  inventory: InstallManifest;
  /** Last committed surface: the `sourceBefore` of the next upgrade's comparison. */
  installSurface: StoredInstallSurface;
  /** Bumped on every committed view replacement. The claim's CAS compares it, so an
   *  apply planned against an older committed state cannot win. */
  committedRevision: number;
  applyState?: ApplyState;
}

export interface ReadManifest {
  inventory: InstallManifest;
  /** null for a legacy row: there is no baseline, which the delta reports as `unknown`
   *  rather than as "nothing changed". */
  installSurface: StoredInstallSurface | null;
  /** 0 for a legacy row — the value a first claim expects. */
  committedRevision: number;
  applyState: ApplyState | null;
  /**
   * A V2 row that has never committed anything: the staging row of a first install that
   * failed or was reaped. Its baseline is EMPTY — nothing was ever published — which is a
   * known fact, unlike a legacy row whose baseline is genuinely unknown.
   *
   * `committedRevision` cannot tell those apart (both read 0), and conflating them made a
   * retry of a failed first install read as an `unknown` replacement of resources that do
   * not exist. Only a V2 row can claim this; anything unrecognized stays conservative.
   */
  neverCommitted: boolean;
}

const EMPTY: InstallManifest = { skills: [], connectors: [], ignored: [], notes: [] };

/**
 * A legacy row stored the `InstallManifest` at the top level. Under V2 those fields
 * moved under `inventory`, so without this reader `marketplace/service.ts` would have
 * silently rendered a blank displayName and no notes for every upgraded plugin.
 *
 * No backfill: a legacy row is upgraded lazily on its next apply.
 */
export function readStoredManifest(raw: unknown): ReadManifest {
  if (!raw || typeof raw !== "object") {
    return { inventory: EMPTY, installSurface: null, committedRevision: 0, applyState: null, neverCommitted: false };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 2) {
    return {
      inventory: o as unknown as InstallManifest,
      installSurface: null,
      committedRevision: 0,
      applyState: null,
      neverCommitted: false,
    };
  }
  const v2 = o as unknown as StoredPluginManifestV2;
  return {
    inventory: v2.inventory ?? EMPTY,
    installSurface: v2.installSurface ?? null,
    // Written by the staging insert as 0 and bumped by every commit, so "still 0" is the
    // one reliable statement that nothing this row describes was ever published.
    neverCommitted: v2.committedRevision === 0,
    // A V2 row that somehow lost its counter must not read as 0: that is the value a
    // FIRST claim expects, so it would let a stale apply win the CAS. Treat a missing
    // counter as a value no claim can match.
    committedRevision: typeof v2.committedRevision === "number" ? v2.committedRevision : Number.NaN,
    applyState: v2.applyState ?? null,
  };
}

/**
 * A row that EXISTS but has never committed anything — a reservation.
 *
 * Both first-install paths need exactly this value: the barrier's staging insert (which
 * carries its claim in `applyState`) and `installPlugin`'s reservation (which does not). Both
 * used to hand-write the literal, and two copies of a shape whose reader discriminates on
 * `schemaVersion` is how one of them quietly starts reading as a legacy row.
 *
 * `writeStoredManifest` cannot express it: that one builds a COMMITTED value and requires a
 * surface. Here `installSurface` is `null` precisely because nothing was published — which
 * `neverCommitted` is what tells apart from a legacy row's genuinely unknown baseline.
 */
export interface ReservedPluginManifest {
  schemaVersion: 2;
  inventory: InstallManifest;
  installSurface: null;
  committedRevision: 0;
  applyState?: ApplyState;
}

export function reservedManifest(applyState?: ApplyState): ReservedPluginManifest {
  return { schemaVersion: 2, inventory: EMPTY, installSurface: null, committedRevision: 0, ...(applyState ? { applyState } : {}) };
}

/** Build the committed V2 value. Kept beside the reader so the two cannot disagree
 *  about where a field lives. */
export function writeStoredManifest(input: {
  inventory: InstallManifest;
  installSurface: StoredInstallSurface;
  committedRevision: number;
}): StoredPluginManifestV2 {
  // `NaN` is what the reader returns for a V2 row that lost its counter, and JSON
  // serializes it to `null` — writing that back would turn a fail-closed read into a
  // permanently unmatchable row with no trace of how it got there.
  if (!Number.isFinite(input.committedRevision)) {
    throw new Error(`Refusing to write a plugin manifest with a non-finite committedRevision (${input.committedRevision})`);
  }
  return { schemaVersion: 2, ...input };
}
