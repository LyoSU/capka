import type { ModelInfo } from "./list-models";

/**
 * Offer a typed-but-unlisted model id as a selectable picker option.
 *
 * Some providers serve models their public catalog never lists — stealth/alpha
 * ids like `openrouter/owl-alpha`, or a freshly released id our 24h catalog sync
 * hasn't picked up yet. OpenRouter is listed purely from that synced catalog, so
 * such a model is otherwise unreachable from the picker. The run path doesn't
 * require a model to be in the catalog (the id passes straight through to the
 * provider — the catalog only drives display/pricing), so the only missing piece
 * is letting the user pick it.
 *
 * Returns a synthetic `ModelInfo` for a fully-qualified id (one containing "/",
 * so a plain word search doesn't spuriously offer a "custom model" for every
 * query), bound to `sample`'s connection so the run uses the right key. Unknown
 * context/price (0) and `tools: true` keep it through the picker's filters.
 * Returns null when the query isn't id-shaped.
 */
export function customModelOption(query: string, sample: ModelInfo | undefined): ModelInfo | null {
  const id = query.trim();
  // Azure model ids are DEPLOYMENT names — user-chosen bare words that no
  // listing can enumerate (the data plane has no deployments endpoint; /models
  // returns base models), so on an Azure connection a typed name-shaped word
  // must be selectable too. Everywhere else the "/" requirement keeps a plain
  // word search from spuriously offering a "custom model" row.
  const bareAzureName = sample?.configProvider === "azure" && /^[\w.-]+$/.test(id);
  if (!id.includes("/") && !bareAzureName) return null;
  return {
    id,
    name: id,
    provider: sample?.provider ?? "Custom",
    context: 0,
    pricing: { prompt: 0, completion: 0 },
    group: sample?.group ?? sample?.provider ?? null,
    icon: sample?.configIcon ?? sample?.icon ?? null,
    capabilities: { vision: false, tools: true, reasoning: false },
    featured: false,
    configId: sample?.configId,
    configLabel: sample?.configLabel,
    configIcon: sample?.configIcon,
    configProvider: sample?.configProvider,
  };
}
