import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";

import { getAuth } from "@/lib/auth";
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

// Cache models for 10 minutes
let cache: { models: ModelInfo[]; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

export async function GET() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const [config] = await db
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.userId, session.user.id), eq(providerConfigs.isActive, true)))
    .limit(1);

  if (!config) return NextResponse.json({ models: [], provider: null });

  // For OpenRouter — fetch live model list
  if (config.provider === "openrouter") {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json({ models: cache.models, provider: "openrouter" });
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
        .filter((m: RawModel) => m.id && !m.id.includes(":free"))
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

      cache = { models, ts: Date.now() };
      return NextResponse.json({ models, provider: "openrouter" });
    } catch {
      return NextResponse.json({ models: [], provider: "openrouter" });
    }
  }

  // For other providers — return empty (they use typed model IDs)
  return NextResponse.json({ models: [], provider: config.provider });
}
