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

// Top-tier model prefixes — only show models from these families
const TOP_MODELS = new Set([
  // OpenAI
  "openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano",
  "openai/gpt-4o", "openai/gpt-4o-mini",
  "openai/o3", "openai/o3-mini", "openai/o4-mini",
  // Anthropic
  "anthropic/claude-sonnet-4", "anthropic/claude-opus-4",
  "anthropic/claude-3.7-sonnet", "anthropic/claude-3.5-haiku",
  // Google
  "google/gemini-2.5-pro", "google/gemini-2.5-flash",
  "google/gemini-2.0-flash",
  // Meta
  "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout",
  "meta-llama/llama-3.3-70b-instruct",
  // DeepSeek
  "deepseek/deepseek-r1", "deepseek/deepseek-chat",
  "deepseek/deepseek-r1-0528",
  // Mistral
  "mistralai/mistral-large", "mistralai/mistral-medium",
  "mistralai/codestral",
  // xAI
  "x-ai/grok-3", "x-ai/grok-3-mini",
  // Qwen
  "qwen/qwen3-235b-a22b", "qwen/qwen3-30b-a3b",
]);

function isTopModel(id: string): boolean {
  // Exact match or prefix match (e.g. "openai/gpt-4.1" matches "openai/gpt-4.1-2025-04-14")
  if (TOP_MODELS.has(id)) return true;
  for (const prefix of TOP_MODELS) {
    if (id.startsWith(prefix + "-") || id.startsWith(prefix + ":")) return true;
  }
  return false;
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

      type RawModel = { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } };
      const models: ModelInfo[] = (data.data ?? [])
        .filter((m: RawModel) => m.id && !m.id.includes(":free") && isTopModel(m.id))
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
        .sort((a: ModelInfo, b: ModelInfo) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));

      cacheMap.set(userId, { models, ts: Date.now() });
      return Response.json({ models, provider: "openrouter" });
    } catch {
      return Response.json({ models: [], provider: "openrouter" });
    }
  }

  // For other providers — return empty (they use typed model IDs)
  return Response.json({ models: [], provider: config.provider });
}
