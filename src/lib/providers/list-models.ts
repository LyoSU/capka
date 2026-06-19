import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { models as modelsTable } from "@/lib/db/schema";
import { iconForGroup, prettyName } from "@/lib/models/normalize";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
import { assertSafeUrl } from "@/lib/net/ssrf";
import { parseOpenRouterModels, OPENROUTER_MODELS_URL, type CatalogModel } from "@/lib/models/catalog";
import { PROVIDER_META, type ProviderName } from "./registry";

/**
 * A model as the picker consumes it. Kept here (not in the route) so server
 * code can produce it without importing a Next route module. The `/api/models`
 * route re-exports the type for the many client components that import it.
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  context: number;
  pricing: { prompt: number; completion: number }; // USD per 1M tokens
  cutoff?: string | null;
  group?: string | null;
  icon?: string | null;
  capabilities?: { vision: boolean; tools: boolean; reasoning: boolean } | null;
  featured?: boolean;
}

const perMillion = (v: string | null | undefined) => (v ? parseFloat(v) * 1_000_000 : 0);

// OpenAI's /v1/models is a flat dump — keep only the chat-capable families.
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt)/i;
const OPENAI_NON_CHAT = /(embedding|whisper|tts|audio|realtime|transcribe|image|dall-e|moderation|instruct)/i;

// Icon slug → display group label, so models from any source group by brand.
const BRAND_LABELS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", meta: "Meta",
  mistral: "Mistral", deepseek: "DeepSeek", xai: "xAI", qwen: "Qwen",
  cohere: "Cohere", perplexity: "Perplexity", microsoft: "Microsoft",
  amazon: "Amazon", nvidia: "NVIDIA", ai21: "AI21", minimax: "MiniMax",
  xiaomi: "Xiaomi", zhipu: "Zhipu", moonshot: "Moonshot",
};

/** Derive a brand group + icon from a model id (works on bare or vendor/model). */
function brandOf(id: string, fallbackGroup: string | null): { group: string | null; icon: string } {
  const slug = iconForGroup(id); // ICON_RULES match the id text directly
  if (slug === "generic") return { group: fallbackGroup, icon: iconForGroup(fallbackGroup ?? "") };
  return { group: BRAND_LABELS[slug] ?? fallbackGroup, icon: slug };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  // `redirect: "manual"` so a permitted host can't 3xx-bounce us to a blocked
  // target (e.g. cloud metadata) after the pre-flight address check.
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (res.status >= 300 && res.status < 400) {
    throw new Error("Provider endpoint returned an unexpected redirect");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

/**
 * SSRF guard to run before ANY live request to a provider — model listing, the
 * "Test" button, AND real inference. Only user-supplied-URL providers
 * (litellm/ollama) carry a base URL worth checking; OpenAI/Anthropic/OpenRouter
 * use fixed public hosts. Resolves DNS and blocks link-local/metadata (always)
 * plus private ranges when the admin opted into the stricter policy.
 */
export async function assertSafeProviderConfig(provider: string, baseUrl?: string | null): Promise<void> {
  if ((provider !== "litellm" && provider !== "ollama") || !baseUrl) return;
  await assertSafeUrl(baseUrl, await getBlockPrivateProviderUrls());
}

type CatalogRow = {
  id: string;
  contextLength: number | null;
  inputPrice: string | null;
  outputPrice: string | null;
  capabilities: unknown;
};

/**
 * Enrich live provider ids with context/pricing/capabilities from the synced
 * catalog (our universal price book). Matched by exact id, then bare model
 * name. One query for the whole batch.
 */
async function catalogLookup(ids: string[]): Promise<(id: string) => CatalogRow | null> {
  const bare = (id: string) => (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id);
  const all = Array.from(new Set([...ids, ...ids.map(bare)]));
  if (!all.length) return () => null;
  const rows = await db
    .select({
      id: modelsTable.id,
      contextLength: modelsTable.contextLength,
      inputPrice: modelsTable.inputPrice,
      outputPrice: modelsTable.outputPrice,
      capabilities: modelsTable.capabilities,
    })
    .from(modelsTable)
    .where(inArray(modelsTable.id, all));
  const map = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => map.get(id) ?? map.get(bare(id)) ?? null;
}

// When a model comes from the user's OWN endpoint (LiteLLM gateway, Ollama,
// direct OpenAI/Anthropic) but isn't in our catalog price book, we don't KNOW
// its capabilities. The picker hides tool-incapable models, so defaulting to
// "unknown" would silently drop the admin's own custom models. Assume usable
// instead — surfacing a reachable model beats hiding it over missing metadata.
const ASSUMED_CAPS: ModelInfo["capabilities"] = { vision: false, tools: true, reasoning: false };

function toModelInfo(
  id: string,
  name: string,
  fallbackGroup: string | null,
  c: CatalogRow | null,
  assumeUsableIfUnknown = false,
): ModelInfo {
  const { group, icon } = brandOf(id, fallbackGroup);
  return {
    id,
    name,
    provider: group ?? "",
    context: c?.contextLength ?? 0,
    pricing: { prompt: perMillion(c?.inputPrice), completion: perMillion(c?.outputPrice) },
    group,
    icon,
    capabilities: (c?.capabilities as ModelInfo["capabilities"]) ?? (assumeUsableIfUnknown ? ASSUMED_CAPS : null),
  };
}

/** OpenRouter: the curated, synced catalog straight from Postgres. */
async function listOpenRouter(): Promise<ModelInfo[]> {
  const rows = await db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.enabled, true), eq(modelsTable.source, "openrouter")))
    .orderBy(desc(modelsTable.featured), asc(modelsTable.group), asc(modelsTable.displayName));

  return rows.map((m) => ({
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
}

/** A freshly-parsed OpenRouter catalog entry → the picker's shape. */
function catalogModelToInfo(m: CatalogModel): ModelInfo {
  return {
    id: m.id,
    name: m.displayName,
    provider: m.id.split("/")[0] || "unknown",
    context: m.contextLength ?? 0,
    pricing: { prompt: (m.inputPrice ?? 0) * 1_000_000, completion: (m.outputPrice ?? 0) * 1_000_000 },
    group: m.group,
    icon: m.icon,
    capabilities: m.capabilities,
  };
}

/**
 * OpenRouter, straight from its live `/models` (the same source the catalog
 * syncs from). Used only as a first-run fallback while the curated DB catalog
 * is still empty, so the picker fills immediately instead of waiting on the
 * background sync. The key is passed through when present; the endpoint is
 * public, so an unauthenticated call still works. Throws on network failure so
 * the caller can surface it.
 */
async function listOpenRouterLive(apiKey?: string): Promise<ModelInfo[]> {
  const raw = await fetchJson(
    OPENROUTER_MODELS_URL,
    apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined,
  );
  return parseOpenRouterModels(raw)
    .filter((m) => m.enabled)
    .map(catalogModelToInfo)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Any OpenAI-compatible endpoint (LiteLLM gateway, OpenAI direct, vLLM…). */
async function listOpenAICompatible(
  baseUrl: string,
  apiKey: string | undefined,
  opts: { filterChat?: boolean; blockPrivate?: boolean } = {},
): Promise<ModelInfo[]> {
  await assertSafeUrl(baseUrl, opts.blockPrivate ?? false);
  const root = baseUrl.replace(/\/+$/, "");
  const url = root.endsWith("/v1") ? `${root}/models` : `${root}/v1/models`;
  const raw = (await fetchJson(url, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined)) as {
    data?: { id: string }[];
  };
  let ids = (raw.data ?? []).map((m) => m.id).filter(Boolean);
  if (opts.filterChat) ids = ids.filter((id) => OPENAI_CHAT.test(id) && !OPENAI_NON_CHAT.test(id));
  const lookup = await catalogLookup(ids);
  return ids
    .map((id) => toModelInfo(id, prettyName(id), null, lookup(id), true))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listAnthropic(apiKey: string): Promise<ModelInfo[]> {
  const raw = (await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  })) as { data?: { id: string; display_name?: string }[] };
  const list = raw.data ?? [];
  const lookup = await catalogLookup(list.map((m) => m.id));
  return list
    .map((m) => toModelInfo(m.id, m.display_name || prettyName(m.id), "Anthropic", lookup(m.id), true))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listOllama(baseUrl: string, blockPrivate: boolean): Promise<ModelInfo[]> {
  await assertSafeUrl(baseUrl, blockPrivate);
  // baseUrl is typically ".../api"; /api/tags is the model list endpoint.
  const root = baseUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const raw = (await fetchJson(`${root}/api/tags`)) as { models?: { name: string }[] };
  return (raw.models ?? [])
    .map((m) => toModelInfo(m.name, prettyName(m.name), "Ollama", null, true))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List the models available for a provider. OpenRouter comes from our synced
 * catalog; everything else is queried live so the picker shows exactly what the
 * configured key/endpoint can reach — no hand-maintained lists, no manual
 * typing. Throws on a provider/network/auth failure so callers can show a
 * friendly message.
 */
// Live provider listings hit the network (15s timeout each) and the picker
// re-fetches on every mount. Cache successful results per credential set for a
// few minutes so navigating between chats doesn't re-probe the provider.
const MODELS_TTL_MS = 5 * 60_000;
const modelsCache = new Map<string, { at: number; models: ModelInfo[] }>();

function modelsCacheKey(o: { provider: string; apiKey?: string; baseUrl?: string }): string {
  const keyHash = o.apiKey ? createHash("sha256").update(o.apiKey).digest("hex").slice(0, 16) : "";
  return `${o.provider}|${o.baseUrl ?? ""}|${keyHash}`;
}

/** Drop the cache (call when a provider config changes so the next list is fresh). */
export function invalidateModelsCache(): void {
  modelsCache.clear();
}

export async function listProviderModels(opts: {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
}): Promise<ModelInfo[]> {
  // OpenRouter is served from the synced DB catalog — already fast, never cache.
  if (opts.provider !== "openrouter") {
    const key = modelsCacheKey(opts);
    const hit = modelsCache.get(key);
    if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
    const models = await listProviderModelsLive(opts);
    modelsCache.set(key, { at: Date.now(), models });
    return models;
  }
  return listProviderModelsLive(opts);
}

async function listProviderModelsLive(opts: {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
}): Promise<ModelInfo[]> {
  // Only the user-supplied-URL providers need the SSRF policy; OpenRouter is
  // catalog-only and OpenAI/Anthropic use fixed public hosts.
  const blockPrivate =
    opts.provider === "litellm" || opts.provider === "ollama"
      ? await getBlockPrivateProviderUrls()
      : false;

  switch (opts.provider) {
    case "openrouter": {
      // Prefer the curated, enriched DB catalog; fall back to a live listing on
      // first run (catalog not yet synced) so the picker is never empty when
      // the network is reachable.
      const curated = await listOpenRouter();
      return curated.length ? curated : listOpenRouterLive(opts.apiKey);
    }
    case "litellm":
      if (!opts.baseUrl) return [];
      return listOpenAICompatible(opts.baseUrl, opts.apiKey, { blockPrivate });
    case "openai":
      if (!opts.apiKey) return [];
      return listOpenAICompatible("https://api.openai.com/v1", opts.apiKey, { filterChat: true });
    case "anthropic":
      if (!opts.apiKey) return [];
      return listAnthropic(opts.apiKey);
    case "ollama":
      return listOllama(opts.baseUrl || PROVIDER_META.ollama.defaultBaseUrl!, blockPrivate);
  }
}
