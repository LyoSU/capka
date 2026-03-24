import { eq, and } from "drizzle-orm";

import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { providerConfigs } from "@/lib/db/schema";
import { getMasterKey } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  context: number;
  pricing: { prompt: number; completion: number };
}

/**
 * Auto-filter SOTA models: for each provider, keep only the top models
 * ranked by a capability score (context * prompt pricing).
 * This avoids hardcoding model names that go stale.
 */
const MAX_PER_PROVIDER = 5;
const MIN_CONTEXT = 32_000;

type RawModel = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
};

function filterSOTA(raw: RawModel[]): ModelInfo[] {
  // Parse and filter out free/tiny models
  const parsed = raw
    .filter((m) => m.id && !m.id.includes(":free") && !m.id.includes(":extended"))
    .map((m) => {
      const prompt = parseFloat(m.pricing?.prompt || "0") * 1_000_000;
      const completion = parseFloat(m.pricing?.completion || "0") * 1_000_000;
      const context = m.context_length || 0;
      return {
        id: m.id,
        name: m.name || m.id.split("/").pop()!,
        provider: m.id.split("/")[0] || "unknown",
        context,
        pricing: { prompt, completion },
        // Capability heuristic: combines price (correlates with quality) and context
        score: prompt * Math.log2(Math.max(context, 1024)),
      };
    })
    .filter((m) => m.context >= MIN_CONTEXT && m.pricing.prompt > 0);

  // Group by provider, take top N per provider by score
  const byProvider = new Map<string, typeof parsed>();
  for (const m of parsed) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  const result: ModelInfo[] = [];
  for (const [, models] of byProvider) {
    models.sort((a, b) => b.score - a.score);
    for (const m of models.slice(0, MAX_PER_PROVIDER)) {
      result.push({
        id: m.id,
        name: m.name,
        provider: m.provider,
        context: m.context,
        pricing: m.pricing,
      });
    }
  }

  return result.sort((a, b) =>
    a.provider.localeCompare(b.provider) || b.pricing.prompt - a.pricing.prompt,
  );
}

// Cache models per user for 10 minutes
const cacheMap = new Map<string, { models: ModelInfo[]; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

export async function GET() {
  const { userId } = await requireSession();

  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, userId), eq(providerConfigs.isActive, true)))
    .limit(1);

  if (!config) return Response.json({ models: [], provider: null });

  // For OpenRouter — fetch live model list
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

    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const data = await res.json();

      const models = filterSOTA(data.data ?? []);

      cacheMap.set(userId, { models, ts: Date.now() });
      return Response.json({ models, provider: "openrouter" });
    } catch {
      return Response.json({ models: [], provider: "openrouter" });
    }
  }

  // For other providers — return empty (they use typed model IDs)
  return Response.json({ models: [], provider: config.provider });
}
