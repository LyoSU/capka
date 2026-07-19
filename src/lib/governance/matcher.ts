import type { CapabilityType, Effect, PolicyMatcher, PolicyRow, PolicyScope } from "./types";

// Pure policy resolution — NO db imports, so client components can import it too.

const SCOPE_RANK: Record<PolicyScope, number> = { system: 0, user: 1, project: 2 };

/** Resolve which policy governs one capability. Most-specific scope wins
 *  (project > user > system); a tie within a scope keeps the first row seen.
 *  Returns null when no row matches — that is the default-allow case. Pure. */
export function explainPolicy(
  rows: PolicyRow[],
  type: CapabilityType,
  key: string,
): { effect: Effect; scope: PolicyScope; policyId?: string } | null {
  let best: { rank: number; effect: Effect; scope: PolicyScope; policyId?: string } | null = null;
  for (const r of rows) {
    if (r.capabilityType !== type || r.capabilityKey !== key) continue;
    const rank = SCOPE_RANK[r.scope];
    if (!best || rank > best.rank) best = { rank, effect: r.effect, scope: r.scope, policyId: r.id };
  }
  return best ? { effect: best.effect, scope: best.scope, policyId: best.policyId } : null;
}

/** Build a lookup from policy rows: most-specific scope wins; default allow. Pure. */
export function buildMatcher(rows: PolicyRow[]): PolicyMatcher {
  return { effect: (type, key) => explainPolicy(rows, type, key)?.effect ?? "allow" };
}
