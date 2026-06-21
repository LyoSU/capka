import { and, eq } from "drizzle-orm";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getMasterKey, getProviderKeyMode } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { resolveProviderConfig } from "@/lib/providers/resolve";
import { listProviderModels, type ModelInfo } from "@/lib/providers/list-models";
import { isProviderName } from "@/lib/providers/registry";
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

  const config = await resolveProviderConfig(userId);
  if (!config) return empty();
  // In shared_only there's no "own key" to switch to, so the "shared" badge is
  // just noise — suppress it by reporting the key as non-shared to the picker.
  const mode = await getProviderKeyMode();
  const showShared = config.isShared && mode !== "shared_only";
  return respond(config.provider, await decryptKey(config.apiKey), config.baseUrl, showShared);
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
