import { apiHandler, requireAdmin } from "@/lib/auth";
import { syncModelCatalog } from "@/lib/models/catalog";
import { invalidateModelsCache } from "@/lib/providers/list-models";

/**
 * Force a model-catalog re-sync from the public sources (OpenRouter + LiteLLM +
 * Models.dev). The worker normally only refreshes when the catalog is empty or
 * 12h stale, so this is how an admin pulls fresh metadata on demand — e.g. after
 * an upgrade taught the parser something new (per-model input modalities). The
 * upsert preserves admin curation (enabled/featured); only metadata/prices move.
 * Also drops the per-credential live-list cache so the picker re-fetches fresh.
 */
export const POST = apiHandler(async () => {
  await requireAdmin();
  const counts = await syncModelCatalog();
  invalidateModelsCache();
  return Response.json({ ok: true, ...counts });
});
