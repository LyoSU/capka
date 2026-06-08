import { and, asc, desc, eq } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { models } from "@/lib/db/schema";
import { resolveProviderConfig } from "@/lib/providers/resolve";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  context: number;
  pricing: { prompt: number; completion: number }; // USD per 1M tokens
  cutoff?: string | null;
  // Catalog extras (drive a grouped, iconed, no-chaos picker).
  group?: string | null;
  icon?: string | null;
  capabilities?: { vision: boolean; tools: boolean; reasoning: boolean } | null;
  featured?: boolean;
}

const perMillion = (v: string | null) => (v ? parseFloat(v) * 1_000_000 : 0);

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();

  const config = await resolveProviderConfig(userId);
  if (!config) return Response.json({ models: [], provider: null, isShared: false });

  // The catalog is synced (OpenRouter + LiteLLM) in the background by the
  // worker. We serve the curated set straight from Postgres — no per-request
  // upstream fetch, no key handling here.
  if (config.provider === "openrouter") {
    const rows = await db
      .select()
      .from(models)
      .where(and(eq(models.enabled, true), eq(models.source, "openrouter")))
      .orderBy(desc(models.featured), asc(models.group), asc(models.displayName));

    const list: ModelInfo[] = rows.map((m) => ({
      id: m.id,
      name: m.displayName,
      provider: m.id.split("/")[0] || "unknown",
      context: m.contextLength ?? 0,
      pricing: { prompt: perMillion(m.inputPrice), completion: perMillion(m.outputPrice) },
      group: m.group,
      icon: m.icon,
      capabilities: (m.capabilities as ModelInfo["capabilities"]) ?? null,
      featured: m.featured ?? false,
    }));

    return Response.json({ models: list, provider: "openrouter", isShared: config.isShared });
  }

  return Response.json({ models: [], provider: config.provider, isShared: config.isShared });
});
