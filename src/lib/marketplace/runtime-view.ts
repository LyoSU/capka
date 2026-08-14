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

/**
 * The MANAGEMENT-list counterpart: which rows a "Connectors" or "Skills" list shows, each
 * tagged with whether its owning install is gone.
 *
 * A plugin-owned resource is managed as part of its plugin on the Extensions tab, so listing
 * it here as well would put one thing in two places — with two enable switches disagreeing
 * about which is authoritative. The exception is an ORPHAN: a `catalog:` row whose install no
 * longer exists, which a failed install can leave behind. It has no Extensions entry to be
 * managed from, so filtering it out here made it unreachable from every screen at once —
 * invisible, unusable by the agent, impossible to delete.
 *
 * Why the flag is a boolean and not `OwnerState`: this filter is what makes `orphaned` the
 * ONLY state a management list can display. `applying` and `failed` belong to an install that
 * still exists, and are shown on its own row on the Extensions tab, where the state applies to
 * every resource it routed at once; `ready` needs no marking. So a per-resource four-state
 * badge has no second reachable value, and a field typed to promise four would be inviting one.
 *
 * Lives here, beside `keepRuntimeVisible`, because the two answer the same question for
 * different audiences and the pair has to be read together. Written out per call site — as it
 * was, in `listServers` only — the skills half was simply never written.
 */
export async function keepManageable<T extends { source?: string | null }>(rows: T[]): Promise<(T & { orphaned: boolean })[]> {
  if (!rows.some((r) => installIdOf(r.source))) return rows.map((r) => ({ ...r, orphaned: false }));
  const states = await ownerStates(rows.map((r) => r.source));
  const out: (T & { orphaned: boolean })[] = [];
  for (const r of rows) {
    if (!installIdOf(r.source)) out.push({ ...r, orphaned: false });
    else if (states.get(r.source!) === "orphaned") out.push({ ...r, orphaned: true });
  }
  return out;
}
