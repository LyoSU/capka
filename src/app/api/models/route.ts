import { and, eq } from "drizzle-orm";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getMasterKey, getProviderKeyMode } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { resolveEnabledConfigs, labelEnabledConfigs } from "@/lib/providers/resolve";
import { listProviderModels, applySharedGovernance, type ModelInfo } from "@/lib/providers/list-models";
import { isProviderName, PROVIDER_META } from "@/lib/providers/registry";
import { syncModelCatalog } from "@/lib/models/catalog";

// Re-exported for the many client components that import the picker's shape.
export type { ModelInfo };

const empty = () => Response.json({ models: [], provider: null, isShared: false });

async function decryptKey(apiKey: string | null): Promise<string | undefined> {
  if (!apiKey) return undefined;
  const mk = await getMasterKey();
  return decrypt(apiKey, mk);
}

async function respond(provider: string, apiKey: string | undefined, baseUrl: string | null, isShared: boolean) {
  if (!isProviderName(provider)) return empty();

  let models: ModelInfo[] = [];
  let error: string | undefined;
  try {
    models = await listProviderModels({ provider, apiKey, baseUrl: baseUrl ?? undefined });
    // Tag the connection provider so the picker gates attachment badges the same
    // way the runner does (single-config / credentials paths carry no configId).
    models = models.map((m) => ({ ...m, configProvider: provider }));
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not load models";
  }

  // First-run safety net: if OpenRouter's catalog hasn't synced yet, kick a
  // background sync so the picker fills in shortly — never block the request.
  let syncing = false;
  if (provider === "openrouter" && models.length === 0 && !error) {
    syncing = true;
    void syncModelCatalog().catch(() => {});
  }

  return Response.json({ models, provider, isShared, syncing, ...(error ? { error } : {}) });
}

/**
 * Active mode: union of every enabled config's catalog, each model tagged with
 * its owning config so the picker can route + label it. The set can mix the
 * user's OWN connections with the admin's SHARED ones — governance (min-context /
 * max-price caps) is enforced only on the shared configs' models, since the owner
 * of a key may pick anything. Per-config failures don't sink the whole list — we
 * surface what loaded and only report an error (or "syncing") when nothing came
 * back at all.
 */
async function respondAggregated(
  configs: Awaited<ReturnType<typeof resolveEnabledConfigs>>,
  mode: Awaited<ReturnType<typeof getProviderKeyMode>>,
): Promise<Response> {
  const labels = labelEnabledConfigs(configs);

  const results = await Promise.all(
    configs.map(async (c) => {
      if (!isProviderName(c.provider)) return { models: [] as ModelInfo[] };
      const apiKey = await decryptKey(c.apiKey);
      try {
        let models = await listProviderModels({ provider: c.provider, apiKey, baseUrl: c.baseUrl ?? undefined });
        // A shared (admin) key spends the org budget, so the admin's min-context /
        // max-price caps gate what users may pick from it; own keys are untouched.
        if (c.isShared) models = await applySharedGovernance(models);
        const configIcon = c.iconSlug || PROVIDER_META[c.provider].iconSlug;
        const tagged = models.map((m) => ({ ...m, configId: c.id, configLabel: labels.get(c.id), configIcon, configProvider: c.provider, configShared: c.isShared }));
        return { models: tagged, provider: c.provider };
      } catch (e) {
        return { models: [] as ModelInfo[], error: e instanceof Error ? e.message : "Could not load models" };
      }
    }),
  );

  const models = results.flatMap((r) => r.models);

  // First-run safety net: an empty OpenRouter config means its catalog hasn't
  // synced — kick a background sync so the picker fills in shortly.
  let syncing = false;
  if (models.length === 0 && configs.some((c) => c.provider === "openrouter") && !results.some((r) => r.error)) {
    syncing = true;
    void syncModelCatalog().catch(() => {});
  }

  const error = models.length === 0 ? results.find((r) => r.error)?.error : undefined;

  // Top-level badge: the whole offering runs on the shared key only when EVERY
  // served config is shared (a pure shared-key user with no own key). In a mixed
  // own+shared union the user's own key is primary, so the per-model `configShared`
  // tag drives the chip instead. Suppressed in shared_only, where there's no own
  // key to contrast against and the badge is just noise.
  const isShared = configs.length > 0 && configs.every((c) => c.isShared) && mode !== "shared_only";

  return Response.json({
    models,
    provider: null,
    isShared,
    syncing,
    ...(error ? { error } : {}),
  });
}

/**
 * GET — models for the caller's active provider, or for a specific saved
 * config via `?configId=` (used when editing that config's default model).
 */
export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const configId = new URL(req.url).searchParams.get("configId");

  if (configId) {
    const [cfg] = await db
      .select()
      .from(providerConfigs)
      .where(and(eq(providerConfigs.id, configId), eq(providerConfigs.userId, userId)))
      .limit(1);
    if (!cfg) return empty();
    return respond(cfg.provider, await decryptKey(cfg.apiKey), cfg.baseUrl, false);
  }

  const configs = await resolveEnabledConfigs(userId);
  if (configs.length === 0) return empty();
  // The set may mix the user's own configs with the admin's shared ones; the
  // badge logic (whole offering shared vs. per-model) lives in respondAggregated.
  const mode = await getProviderKeyMode();
  return respondAggregated(configs, mode);
});

/**
 * POST — models for credentials that aren't saved yet (setup wizard and the
 * "add provider" form), so the picker can show real models — and validate the
 * key — before anything is persisted.
 */
export const POST = apiHandler(async (req: Request) => {
  // Lists models for arbitrary credentials/base URLs — restrict to the roles
  // that can configure providers (also covers the in-progress admin in setup).
  await requireRole("admin", "user");
  const { provider, apiKey, baseUrl } = await req.json();
  if (!provider) return empty();
  return respond(provider, apiKey || undefined, baseUrl ?? null, false);
});
