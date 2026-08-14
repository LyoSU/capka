import { pool } from "@/lib/db";

/**
 * Which plugin-owned resources the agent may see (docs/plugin-install-review-spec.md §8).
 *
 * The mutation fence protects writers; readers still need protecting from intermediate
 * state. `listEnabledServerConfigs` and `listAvailableSkills` filter on scope and
 * `enabled` with no join to the owning install, so mid-apply the agent could pick up a
 * half-updated set, a connector that was never finalized, or the leftovers of an install
 * that failed. Finalize becomes the publication moment.
 *
 * `enabled` is never touched by any of this, so a user's own choice survives an apply
 * untouched — which is why this is a separate filter and not a column.
 */

/**
 * What state a resource's owning install is in.
 *
 * The management API must be able to say WHICH of these a resource is in, per resource
 * and not just per install: without it the UI cannot tell "temporarily unavailable" from
 * "gone", and a user staring at a connector that stopped answering has no way to find
 * out why. §9 identifies that as the worst state this feature can produce.
 */
export type OwnerState = "ready" | "applying" | "failed" | "orphaned";

const TAG = "catalog:";

/** The install id inside a `catalog:<id>` source tag, or null for a hand-added row. */
export function installIdOf(source: string | null | undefined): string | null {
  return source && source.startsWith(TAG) ? source.slice(TAG.length) : null;
}

/**
 * Resolve the owner state of every `catalog:` source in `sources`.
 *
 * Only plugin-owned sources appear in the result; a hand-added row has no owner and is
 * always visible, so callers treat "absent from this map" as "not plugin-owned".
 *
 * `orphaned` is the owner-missing case — a resource tagged for an install row that no
 * longer exists, which today's failed installs can leave behind. It is deliberately a
 * state rather than an error: visible in Connections so it can be removed by hand,
 * invisible to the agent so it cannot be used.
 */
export async function ownerStates(sources: (string | null | undefined)[]): Promise<Map<string, OwnerState>> {
  const ids = [...new Set(sources.map(installIdOf).filter((id): id is string => id != null))];
  const out = new Map<string, OwnerState>();
  if (ids.length === 0) return out;

  const { rows } = await pool.query<{ id: string; status: string | null }>(
    `SELECT id, manifest #>> '{applyState,status}' AS status FROM plugin_installs WHERE id = ANY($1::text[])`,
    [ids],
  );
  // Seeded as orphaned, then overwritten by whatever the row says. Absence from the
  // query result is therefore fail-closed by CONSTRUCTION rather than by a branch
  // someone could forget: an id the database did not return stays invisible.
  for (const id of ids) out.set(`${TAG}${id}`, "orphaned");
  for (const r of rows) {
    out.set(`${TAG}${r.id}`, r.status === "applying" ? "applying" : r.status === "failed" ? "failed" : "ready");
  }
  return out;
}

/**
 * The runtime filter: keep a row when it is not plugin-owned, or when its owning install
 * has a committed view.
 *
 * Mirrors how `mutedIds` already layers a per-user opt-out on top of the row query,
 * rather than joining in SQL — one extra query for the whole set, and the same shape the
 * two call sites already use.
 */
export async function keepRuntimeVisible<T extends { source?: string | null }>(rows: T[]): Promise<T[]> {
  if (!rows.some((r) => installIdOf(r.source))) return rows;
  const states = await ownerStates(rows.map((r) => r.source));
  return rows.filter((r) => {
    const owned = installIdOf(r.source);
    if (!owned) return true;
    return states.get(r.source!) === "ready";
  });
}
