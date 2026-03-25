import { eq, and } from "drizzle-orm";

import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs, users } from "@/lib/db/schema";
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
}

// Cache models per user for 10 minutes
const cacheMap = new Map<string, { models: ModelInfo[]; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

export async function GET() {
  const { userId } = await requireSession();

  // User's own config, then fallback to admin's shared config
  let [config] = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
    .limit(1);

  if (!config) {
    const adminConfigs = await db
      .select({ config: providerConfigs })
      .from(providerConfigs)
      .innerJoin(users, eq(providerConfigs.userId, users.id))
      .where(and(eq(users.role, "admin"), eq(providerConfigs.isActive, true)))
      .limit(1);
    config = adminConfigs[0]?.config;
  }

  if (!config) return Response.json({ models: [], provider: null });

  if (config.provider === "openrouter") {
    const cached = cacheMap.get(userId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return Response.json({ models: cached.models, provider: "openrouter" });
    }

    let apiKey = config.apiKey;
    if (apiKey) {
      const mk = await getMasterKey();
      apiKey = decrypt(apiKey, mk);
    }

    const minCtxSetting = await getSetting("model_min_context");
    const minContext = minCtxSetting ? parseInt(minCtxSetting, 10) : DEFAULT_MODEL_MIN_CONTEXT;

    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const data = await res.json();

      type RawModel = {
        id: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      };

      // Date-stamped variant pattern: ends with -YYYY-MM-DD or -MMDD
      const DATED = /-(20\d{2}-\d{2}-\d{2}|\d{4})$/;

      const models: ModelInfo[] = (data.data ?? [])
        .filter((m: RawModel) => {
          if (!m.id || m.id.includes(":free") || m.id.includes(":extended")) return false;
          const slug = m.id.split("/")[1] || "";
          // Skip date-stamped duplicates (e.g. gpt-5.4-2026-01-15)
          if (DATED.test(slug)) return false;
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
        }))
        .sort((a: ModelInfo, b: ModelInfo) =>
          a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
        );

      cacheMap.set(userId, { models, ts: Date.now() });
      return Response.json({ models, provider: "openrouter" });
    } catch {
      return Response.json({ models: [], provider: "openrouter" });
    }
  }

  return Response.json({ models: [], provider: config.provider });
}
