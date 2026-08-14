import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import type { ResolvedPluginPlan } from "./plan";

/**
 * What the world said about a plan, as opposed to what the artifact says. Recomputed
 * on every apply and never persisted into a baseline: a stale probe result stored as
 * an artifact property would make the next upgrade read a DNS change as a plugin
 * change (docs/plugin-install-review-spec.md §4).
 *
 * Phase A carries only the OAuth probe `applyPlugin` already performed. `preflightUrl`
 * arrives in Phase B — Phase A introduces no network call that did not exist.
 */
export interface ReviewObservations {
  /** Connector name → the auth kind its endpoint advertises. Absent for stdio. */
  detectedAuth: Record<string, "token" | "oauth">;
}

export async function observePluginPlan(plan: ResolvedPluginPlan): Promise<ReviewObservations> {
  const detectedAuth: Record<string, "token" | "oauth"> = {};
  for (const c of plan.connectors) {
    if (c.kind !== "remote" || !c.url) continue;
    // A probe failure is a verdict, not an error: the install proceeds with the same
    // `token` default it uses today.
    try { detectedAuth[c.name] = await detectAuthKind(c.url); } catch { detectedAuth[c.name] = "token"; }
  }
  return { detectedAuth };
}
