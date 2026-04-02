import { requireSession, apiHandler } from "@/lib/auth";
import { resolveProviderConfig } from "@/lib/providers/resolve";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  context: number;
  pricing: { prompt: number; completion: number };
  cutoff?: string | null;
}

const MAX_CACHE_ENTRIES = 50;
const cacheMap = new Map<string, { models: ModelInfo[]; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();

  const config = await resolveProviderConfig(userId);
  if (!config) return Response.json({ models: [], provider: null, isShared: false });

  if (config.provider === "openrouter") {
    // Cache key includes config id so provider/key changes invalidate immediately
    const cacheKey = `${userId}:${config.id}`;
    const cached = cacheMap.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return Response.json({ models: cached.models, provider: "openrouter", isShared: config.isShared });
    }

    let apiKey = config.apiKey;
    if (apiKey) {
      const mk = await getMasterKey();
      apiKey = decrypt(apiKey, mk);
    }

    const minCtxSetting = await getSetting("model_min_context");
    const minContext = minCtxSetting ? parseInt(minCtxSetting, 10) : DEFAULT_MODEL_MIN_CONTEXT;

    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const data = await res.json();

    type RawModel = {
      id: string;
      name?: string;
      created?: number;
      knowledge_cutoff?: string | null;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
    };

    // Hide models added to OpenRouter more than 2 months ago
    const TWO_MONTHS_AGO = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 60;

    // Date-stamped variant pattern: ends with -YYYY-MM-DD or -MMDD
    const DATED = /-(20\d{2}-\d{2}-\d{2}|\d{4})$/;

    const models: ModelInfo[] = (data.data ?? [])
      .filter((m: RawModel) => {
        if (!m.id || m.id.includes(":free") || m.id.includes(":extended")) return false;
        const slug = m.id.split("/")[1] || "";
        if (DATED.test(slug)) return false;
        if (m.created && m.created < TWO_MONTHS_AGO) return false;
        const prompt = parseFloat(m.pricing?.prompt || "0");
        return prompt > 0 && (m.context_length || 0) >= minContext;
      })
      .map((m: RawModel) => ({
        id: m.id,
        name: m.name || m.id.split("/").pop(),
        provider: m.id.split("/")[0] || "unknown",
        context: m.context_length || 0,
        pricing: {
          prompt: parseFloat(m.pricing?.prompt || "0") * 1_000_000,
          completion: parseFloat(m.pricing?.completion || "0") * 1_000_000,
        },
        cutoff: m.knowledge_cutoff || null,
      }))
      .sort((a: ModelInfo, b: ModelInfo) =>
        a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
      );

    cacheMap.set(cacheKey, { models, ts: Date.now() });
    // Evict stale + cap size
    const now = Date.now();
    for (const [k, v] of cacheMap) {
      if (now - v.ts > CACHE_TTL) cacheMap.delete(k);
    }
    if (cacheMap.size > MAX_CACHE_ENTRIES) {
      const oldest = [...cacheMap.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) cacheMap.delete(oldest[0]);
    }
    return Response.json({ models, provider: "openrouter", isShared: config.isShared });
  }

  return Response.json({ models: [], provider: config.provider, isShared: config.isShared });
});
