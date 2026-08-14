import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { preflightUrl, type UrlVerdict } from "@/lib/net/ssrf";
import type { ResolvedPluginPlan } from "./plan";

/**
 * What the world said about a plan, as opposed to what the artifact says. Recomputed on
 * every apply and never persisted into a baseline
 * (docs/plugin-install-review-spec.md §4).
 *
 * The separation is the point: a DNS or OAuth-discovery result is a live fact about the
 * world, not a property of the pinned commit. Storing one in the baseline would make the
 * next upgrade compare a fresh observation against a stale one and report a plugin
 * change where only the world moved.
 */
export interface ReviewObservations {
  /** Connector name → what a preflight of its URL saw. Absent for stdio. */
  urls: Record<string, UrlVerdict>;
  /** Connector name → the auth kind its endpoint advertises. Absent for stdio. */
  detectedAuth: Record<string, "token" | "oauth">;
  /** The private-range policy these verdicts were computed under. Recorded because the
   *  same URL is safe on one instance and refused on another, so a verdict is
   *  meaningless without it. */
  policy: { blockPrivate: boolean };
  /** For display only. Deliberately NOT covered by the review hash: a review must not
   *  go stale merely because time passed. */
  observedAt: string;
}

/**
 * The policy is a parameter rather than a settings read, so the verdicts and the
 * `policy` recorded beside them provably come from one value — a second read could
 * disagree with the first and leave a review describing a policy it was not computed
 * under.
 */
export async function observePluginPlan(
  plan: ResolvedPluginPlan,
  policy: { blockPrivate: boolean },
): Promise<ReviewObservations> {
  const urls: Record<string, UrlVerdict> = {};
  const detectedAuth: Record<string, "token" | "oauth"> = {};
  // Two connectors on one host would otherwise resolve it twice. Per call only: a
  // verdict must not outlive the review it was computed for.
  const seen = new Map<string, UrlVerdict>();

  for (const c of plan.connectors) {
    if (c.kind !== "remote" || !c.url) continue;
    const cached = seen.get(c.url);
    const verdict = cached ?? await preflightUrl(c.url, policy.blockPrivate);
    if (!cached) seen.set(c.url, verdict);
    urls[c.name] = verdict;
    // A probe failure is a verdict, not an error: the install proceeds with the same
    // `token` default it uses today. An unsafe URL is not probed at all — reaching a
    // blocked address to ask about its auth would be the SSRF the preflight just
    // refused.
    if (verdict === "allowed") {
      try { detectedAuth[c.name] = await detectAuthKind(c.url); } catch { detectedAuth[c.name] = "token"; }
    } else {
      detectedAuth[c.name] = "token";
    }
  }

  return { urls, detectedAuth, policy, observedAt: new Date().toISOString() };
}
