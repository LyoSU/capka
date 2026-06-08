import { eq, or, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { models } from "@/lib/db/schema";
import {
  type Capabilities,
  groupFromName,
  groupForProvider,
  iconForModel,
  isDatedSlug,
  prettyName,
} from "./normalize";

export interface CatalogModel {
  // Integration the model is served through. Open-ended on purpose: more
  // integrations (direct Anthropic/OpenAI, Ollama, LiteLLM proxy, Azure,
  // Bedrock, custom gateways…) will be added over time.
  id: string;
  source: string;
  displayName: string;
  group: string | null;
  icon: string;
  contextLength: number | null;
  inputPrice: number | null; // USD per token
  outputPrice: number | null;
  cacheReadPrice: number | null;
  capabilities: Capabilities;
  enabled: boolean; // default curation; admin choice overrides on re-sync
}

// Minimum context to count a model as "serious" for default curation.
const MIN_CONTEXT = 8000;
// Variant tags we never surface by default (free tiers, betas, etc.).
const NOISY_TAG = /:(free|extended|beta|thinking|nitro|online)/i;

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// ── Parsers (pure) ───────────────────────────────────────────

interface ORModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  supported_parameters?: string[];
}

export function parseOpenRouterModels(raw: unknown): CatalogModel[] {
  const data = (raw as { data?: ORModel[] })?.data ?? [];
  const out: CatalogModel[] = [];
  for (const m of data) {
    if (!m?.id) continue;
    const input = num(m.pricing?.prompt);
    const output = num(m.pricing?.completion);
    const cacheRead = num(m.pricing?.input_cache_read);
    const ctx = m.context_length ?? null;
    const params = m.supported_parameters ?? [];
    const group = groupFromName(m.name, m.id);
    const enabled =
      !NOISY_TAG.test(m.id) &&
      !isDatedSlug(m.id) &&
      (input ?? 0) > 0 &&
      (ctx ?? 0) >= MIN_CONTEXT;
    out.push({
      id: m.id,
      source: "openrouter",
      displayName: prettyName(m.id, m.name),
      group,
      icon: iconForModel(group, "OpenRouter"),
      contextLength: ctx,
      inputPrice: input,
      outputPrice: output,
      cacheReadPrice: cacheRead,
      capabilities: {
        vision: !!m.architecture?.input_modalities?.includes("image"),
        tools: params.includes("tools") || params.includes("tool_choice"),
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
      },
      enabled,
    });
  }
  return out;
}

interface LLEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  max_input_tokens?: number;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
  supports_reasoning?: boolean;
}

/**
 * LiteLLM is our universal price/capability book. We import only chat models
 * and keep them disabled by default (they back pricing + direct-provider
 * availability, while OpenRouter drives the default visible picker).
 */
export function parseLiteLLMModels(raw: unknown): CatalogModel[] {
  const obj = (raw as Record<string, LLEntry>) ?? {};
  const out: CatalogModel[] = [];
  for (const [id, e] of Object.entries(obj)) {
    if (id === "sample_spec" || !e || typeof e !== "object") continue;
    if (e.mode && e.mode !== "chat") continue;
    const group = groupForProvider(e.litellm_provider);
    out.push({
      id,
      source: "litellm",
      displayName: prettyName(id),
      group,
      icon: iconForModel(group, e.litellm_provider),
      contextLength: e.max_input_tokens ?? null,
      inputPrice: numv(e.input_cost_per_token),
      outputPrice: numv(e.output_cost_per_token),
      cacheReadPrice: numv(e.cache_read_input_token_cost),
      capabilities: {
        vision: !!e.supports_vision,
        tools: !!e.supports_function_calling,
        reasoning: !!e.supports_reasoning,
      },
      enabled: false,
    });
  }
  return out;
}

function num(s: string | undefined): number | null {
  if (s == null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function numv(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// ── Sync (I/O) ───────────────────────────────────────────────

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Refresh the model catalog from public sources. Each source is independent:
 * one failing never blocks the other. Admin curation (enabled/featured) is
 * preserved across syncs — only metadata/prices are updated for existing rows.
 * Returns the number of rows upserted. Never throws.
 */
export async function syncModelCatalog(): Promise<{ openrouter: number; litellm: number }> {
  let or = 0;
  let ll = 0;
  // OpenRouter first so its rich names/grouping win for shared ids; LiteLLM
  // then fills in any ids OpenRouter doesn't carry.
  try {
    const parsed = parseOpenRouterModels(await fetchJson(OPENROUTER_MODELS_URL));
    await upsertModels(parsed);
    or = parsed.length;
  } catch (err) {
    console.error("[catalog] OpenRouter sync failed (non-fatal):", err);
  }
  try {
    const parsed = parseLiteLLMModels(await fetchJson(LITELLM_PRICES_URL));
    await upsertModels(parsed, { skipExisting: true });
    ll = parsed.length;
  } catch (err) {
    console.error("[catalog] LiteLLM sync failed (non-fatal):", err);
  }
  priceCache.clear();
  console.log(`[catalog] synced ${or} OpenRouter + ${ll} LiteLLM models`);
  return { openrouter: or, litellm: ll };
}

const CHUNK = 500; // keep well under Postgres' parameter limit

async function upsertModels(list: CatalogModel[], opts?: { skipExisting?: boolean }) {
  if (!list.length) return;
  const now = new Date();
  const rows = list.map((m) => ({
    id: m.id,
    source: m.source,
    displayName: m.displayName,
    group: m.group,
    icon: m.icon,
    contextLength: m.contextLength,
    inputPrice: m.inputPrice === null ? null : String(m.inputPrice),
    outputPrice: m.outputPrice === null ? null : String(m.outputPrice),
    cacheReadPrice: m.cacheReadPrice === null ? null : String(m.cacheReadPrice),
    capabilities: m.capabilities,
    enabled: m.enabled,
    updatedAt: now,
  }));

  // Bulk upsert in chunks. One round-trip per chunk instead of per row keeps
  // a ~3k-model sync fast. Admin curation (enabled/featured) is preserved by
  // not touching those columns on conflict.
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const insert = db.insert(models).values(batch);
    if (opts?.skipExisting) {
      await insert.onConflictDoNothing();
    } else {
      await insert.onConflictDoUpdate({
        target: models.id,
        set: {
          source: sql`excluded.source`,
          displayName: sql`excluded.display_name`,
          group: sql`excluded."group"`,
          icon: sql`excluded.icon`,
          contextLength: sql`excluded.context_length`,
          inputPrice: sql`excluded.input_price`,
          outputPrice: sql`excluded.output_price`,
          cacheReadPrice: sql`excluded.cache_read_price`,
          capabilities: sql`excluded.capabilities`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    }
  }
}

// ── Price lookup ─────────────────────────────────────────────

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

const priceCache = new Map<string, ModelPrice | null>();

/**
 * Resolve a model's per-token price from the catalog. Tries the exact id,
 * then the provider-stripped id (e.g. "anthropic/claude-…" → "claude-…").
 * Cached in-process; cache is cleared on each sync.
 */
export async function getModelPrice(modelId: string): Promise<ModelPrice | null> {
  if (priceCache.has(modelId)) return priceCache.get(modelId)!;
  const stripped = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  const rows = await db
    .select({
      id: models.id,
      inputPrice: models.inputPrice,
      outputPrice: models.outputPrice,
      cacheReadPrice: models.cacheReadPrice,
    })
    .from(models)
    .where(or(eq(models.id, modelId), eq(models.id, stripped), like(models.id, `%/${stripped}`)))
    .limit(5);

  // Prefer an exact id match, otherwise take the first with a usable price.
  const exact = rows.find((r) => r.id === modelId) ?? rows.find((r) => r.inputPrice != null);
  const price = exact?.inputPrice != null
    ? {
        input: parseFloat(exact.inputPrice),
        output: parseFloat(exact.outputPrice ?? "0"),
        cacheRead: parseFloat(exact.cacheReadPrice ?? "0"),
      }
    : null;
  priceCache.set(modelId, price);
  return price;
}
