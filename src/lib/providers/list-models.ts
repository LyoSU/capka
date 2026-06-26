import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { models as modelsTable } from "@/lib/db/schema";
import { iconForGroup, prettyName } from "@/lib/models/normalize";
import { getBlockPrivateProviderUrls, getModelMinContext, getModelMaxPrice } from "@/lib/settings";
import { assertSafeUrl } from "@/lib/net/ssrf";
import { parseOpenRouterModels, OPENROUTER_MODELS_URL, type CatalogModel } from "@/lib/models/catalog";
import { PROVIDER_META, type ProviderName, type Modality } from "./registry";

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
  capabilities?: { vision: boolean; tools: boolean; reasoning: boolean; input?: Modality[] } | null;
  featured?: boolean;
  // When the picker aggregates several enabled provider configs, each model is
  // tagged with the config it came from: `configId` routes the selection (the
  // same model id can exist in two configs), `configLabel` names the connection
  // (its rail tab) and `configIcon` is that connection's provider glyph. Absent
  // in single-credential modes.
  configId?: string;
  configLabel?: string;
  configIcon?: string;
  // The provider of the owning connection (openrouter / litellm / anthropic …).
  // Distinct from `provider` above, which is the model's BRAND. Lets the picker
  // gate native-attachment badges through the same connection-aware logic the
  // runner uses (`acceptsNativeFile`), so an audio icon never promises what the
  // connection won't actually deliver.
  configProvider?: string;
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
 * "Test" button, AND real inference. Any user-supplied base URL is the vector,
 * regardless of provider (LiteLLM/Ollama, but also a custom OpenAI/Anthropic
 * endpoint): a config with no baseUrl uses a fixed public host and is exempt.
 * Resolves DNS and blocks link-local/metadata (always) plus private ranges when
 * the admin opted into the stricter policy.
 */
export async function assertSafeProviderConfig(_provider: string, baseUrl?: string | null): Promise<void> {
  if (!baseUrl) return;
  await assertSafeUrl(baseUrl, await getBlockPrivateProviderUrls());
}

type CatalogRow = {
  id: string;
  source: string;
  displayName: string | null;
  group: string | null;
  icon: string | null;
  contextLength: number | null;
  cutoff: string | null;
  inputPrice: string | null;
  outputPrice: string | null;
  capabilities: unknown;
};

const bareId = (id: string) => (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id);

/**
 * Enrich live provider ids with the synced catalog (our universal price book +
 * canonical names). A custom OpenAI-compatible endpoint reports a bare id like
 * "glm-5.2"; OpenRouter stores it as "z-ai/glm-5.2", so we also match by suffix
 * ("%/glm-5.2"), exactly like getModelPrice. When several rows share a bare id,
 * the OpenRouter row wins — it carries the real display name/group/icon, while
 * a LiteLLM row only has a slug-normalized name. One query for the whole batch.
 */
async function catalogLookup(
  ids: string[],
  preferSource: "openrouter" | "litellm" = "openrouter",
): Promise<(id: string) => CatalogRow | null> {
  if (!ids.length) return () => null;
  const exact = Array.from(new Set(ids));
  const bares = Array.from(new Set(ids.map(bareId)));
  const rows = await db
    .select({
      id: modelsTable.id,
      source: modelsTable.source,
      displayName: modelsTable.displayName,
      group: modelsTable.group,
      icon: modelsTable.icon,
      contextLength: modelsTable.contextLength,
      cutoff: modelsTable.cutoff,
      inputPrice: modelsTable.inputPrice,
      outputPrice: modelsTable.outputPrice,
      capabilities: modelsTable.capabilities,
    })
    .from(modelsTable)
    .where(or(inArray(modelsTable.id, exact), ...bares.map((b) => like(modelsTable.id, `%/${b}`))));

  const byId = new Map<string, CatalogRow>();
  const byBare = new Map<string, CatalogRow>();
  for (const r of rows) {
    byId.set(r.id, r);
    const b = bareId(r.id);
    const cur = byBare.get(b);
    // For a bare-id collision across sources, keep the preferred source's row.
    // Default prefers OpenRouter (canonical name/group/icon for display); modality
    // lookup prefers the connection's own source so a LiteLLM/direct model isn't
    // described by OpenRouter's serving of the same id.
    if (!cur || (cur.source !== preferSource && r.source === preferSource)) byBare.set(b, r);
  }
  return (id: string) => byId.get(id) ?? byBare.get(bareId(id)) ?? null;
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
  // When OpenRouter carries this model, prefer its canonical name/group/icon so
  // a model served through a custom OpenAI-compatible endpoint renders exactly
  // like the same model via OpenRouter (e.g. "Z.ai: GLM 5.2" under a "Z.ai"
  // header, which the picker then trims to "GLM 5.2"). LiteLLM rows are skipped
  // here — their displayName is only a slug-normalized fallback.
  const canon = c?.source === "openrouter" ? c : null;
  const brand = brandOf(id, fallbackGroup);
  const group = canon?.group ?? brand.group;
  const icon = canon?.icon ?? brand.icon;
  return {
    id,
    name: canon?.displayName ?? name,
    provider: group ?? "",
    context: c?.contextLength ?? 0,
    cutoff: c?.cutoff ?? null,
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
    cutoff: m.cutoff ?? null,
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
 * OpenRouter, straight from its live `/models` with the user's key — the source
 * of truth for the picker. Shows EVERYTHING the API returns for this key (new
 * and stealth/preview models the 24h catalog sync hasn't picked up, models the
 * key has special access to), with no curation filter — the catalog is only used
 * to enrich (featured, knowledge cutoff). The key is passed through when present;
 * the endpoint also works unauthenticated. Throws on network failure so the
 * caller can fall back to the curated catalog.
 */
async function listOpenRouterLive(apiKey?: string): Promise<ModelInfo[]> {
  const raw = await fetchJson(
    OPENROUTER_MODELS_URL,
    apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined,
  );
  return parseOpenRouterModels(raw)
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
  // Append `/models` when the base already carries a version segment (/v1, but
  // also Z.ai's /v4); otherwise assume the conventional /v1/models.
  const url = /\/v\d+$/.test(root) ? `${root}/models` : `${root}/v1/models`;
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

async function listAnthropic(
  apiKey: string,
  baseUrl?: string,
  blockPrivate = false,
): Promise<ModelInfo[]> {
  // A custom endpoint (an Anthropic-compatible aggregator like yunwu.ai) is
  // reached over the native Messages API at /v1/messages, but its MODEL LISTING
  // is almost always the OpenAI-shaped /v1/models behind Bearer auth — not
  // Anthropic's native x-api-key /v1/models. List it like any compatible
  // endpoint so the picker populates instead of 401-ing against api.anthropic.com.
  if (baseUrl) return listOpenAICompatible(baseUrl, apiKey, { blockPrivate });
  const raw = (await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  })) as { data?: { id: string; display_name?: string }[] };
  const list = raw.data ?? [];
  const lookup = await catalogLookup(list.map((m) => m.id));
  return list
    .map((m) => toModelInfo(m.id, m.display_name || prettyName(m.id), "Anthropic", lookup(m.id), true))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Google Gemini: its own `/v1beta/models` listing (not OpenAI-shaped). Keep only
 * models that can actually chat (`generateContent`), dropping embedding/AQA/TTS
 * and the legacy `models/` prefix. Enriched against the catalog like the rest.
 */
async function listGoogle(apiKey: string): Promise<ModelInfo[]> {
  const raw = (await fetchJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": apiKey },
  })) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
  const list = (raw.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/i.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), displayName: m.displayName }));
  const lookup = await catalogLookup(list.map((m) => m.id));
  return list
    .map((m) => toModelInfo(m.id, m.displayName || prettyName(m.id), "Google", lookup(m.id), true))
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

/**
 * Admin governance for a SHARED offering: hide models below a minimum context
 * or above a maximum price, so users spending the admin's key/budget can't
 * reach tiny-context or budget-busting models. Applied only where the served
 * list is shared (the owner sees everything). A model with unknown context or
 * price (0) is always kept — missing metadata never hides an option. Read fresh
 * each call so a settings change takes effect without waiting on the cache TTL.
 */
export async function applySharedGovernance(models: ModelInfo[]): Promise<ModelInfo[]> {
  const [minContext, maxPrice] = await Promise.all([getModelMinContext(), getModelMaxPrice()]);
  return models.filter((m) => {
    if (minContext > 0 && m.context > 0 && m.context < minContext) return false;
    if (maxPrice > 0 && m.pricing.completion > maxPrice) return false;
    return true;
  });
}

/**
 * The native input modalities the catalog knows THIS model accepts (OpenRouter's
 * `input_modalities`), or null when the model isn't in the catalog / the source
 * didn't report them — the caller then falls back to the provider's static caps.
 * Matched by exact then bare id, exactly like the price lookup.
 */
export async function getModelInputModalities(
  modelId: string,
  provider?: string,
): Promise<Modality[] | null> {
  // Read the modality row from the SAME source the connection serves through, so
  // a LiteLLM/direct model isn't described by OpenRouter's serving of the same id
  // (and vice-versa). Direct providers are covered by the LiteLLM price book.
  const preferSource = provider === "openrouter" ? "openrouter" : "litellm";
  const lookup = await catalogLookup([modelId], preferSource);
  const caps = lookup(modelId)?.capabilities as { input?: Modality[] } | null | undefined;
  return caps?.input && caps.input.length ? caps.input : null;
}

/** The model's completion price in USD per 1M tokens from the synced catalog,
 *  or 0 when unknown (a generic gateway with no metadata) — used to enforce the
 *  shared price cap on the inference path. */
export async function getModelCompletionPriceUsdPerM(modelId: string): Promise<number> {
  const lookup = await catalogLookup([modelId]);
  const row = lookup(modelId);
  return row ? perMillion(row.outputPrice) : 0;
}

export async function listProviderModels(opts: {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
}): Promise<ModelInfo[]> {
  // Governance is NOT applied here — it's scoped to shared offerings by the
  // caller (see applySharedGovernance). Own/owner lists are unfiltered.
  return listProviderModelsCached(opts);
}

/** The raw list, cached per credential set. */
async function listProviderModelsCached(opts: {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
}): Promise<ModelInfo[]> {
  // All providers (incl. OpenRouter, now a live keyed API call) cache per
  // credential set for a few minutes so re-mounting the picker doesn't re-probe.
  const key = modelsCacheKey(opts);
  const hit = modelsCache.get(key);
  if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
  const models = await listProviderModelsLive(opts);
  modelsCache.set(key, { at: Date.now(), models });
  return models;
}

async function listProviderModelsLive(opts: {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
}): Promise<ModelInfo[]> {
  // Only the user-supplied-URL providers need the SSRF policy; OpenRouter is
  // catalog-only and OpenAI/Anthropic use fixed public hosts.
  // Any user-supplied base URL is the SSRF vector, regardless of provider — so
  // a custom Anthropic/OpenAI endpoint is policed just like a LiteLLM/Ollama one.
  const blockPrivate =
    opts.provider === "litellm" || opts.provider === "ollama" || opts.baseUrl
      ? await getBlockPrivateProviderUrls()
      : false;

  switch (opts.provider) {
    case "openrouter": {
      // Source of truth = the live API for this key (everything it returns, incl.
      // new/stealth models the 24h catalog lacks). Enrich with the curated
      // catalog (featured, knowledge cutoff) by id. Fall back to the catalog only
      // if the live call fails, so the picker is never empty offline.
      const [live, curated] = await Promise.all([
        listOpenRouterLive(opts.apiKey).catch(() => [] as ModelInfo[]),
        listOpenRouter(),
      ]);
      if (!live.length) return curated;
      const meta = new Map(curated.map((m) => [m.id, m]));
      return live.map((m) => {
        const c = meta.get(m.id);
        return c ? { ...m, featured: c.featured, cutoff: c.cutoff ?? m.cutoff } : m;
      });
    }
    case "litellm":
      if (!opts.baseUrl) return [];
      return listOpenAICompatible(opts.baseUrl, opts.apiKey, { blockPrivate });
    case "deepseek":
    case "mistral":
    case "xai":
    case "zhipu": {
      // First-party OpenAI-compatible presets: fixed public host (no SSRF
      // policy), key required, base URL from the registry unless overridden.
      if (!opts.apiKey) return [];
      const baseUrl = opts.baseUrl || PROVIDER_META[opts.provider].defaultBaseUrl!;
      return listOpenAICompatible(baseUrl, opts.apiKey);
    }
    case "openai":
      if (!opts.apiKey) return [];
      return listOpenAICompatible("https://api.openai.com/v1", opts.apiKey, { filterChat: true });
    case "anthropic":
      if (!opts.apiKey) return [];
      return listAnthropic(opts.apiKey, opts.baseUrl, blockPrivate);
    case "google":
      if (!opts.apiKey) return [];
      return listGoogle(opts.apiKey);
    case "ollama":
      return listOllama(opts.baseUrl || PROVIDER_META.ollama.defaultBaseUrl!, blockPrivate);
  }
}
