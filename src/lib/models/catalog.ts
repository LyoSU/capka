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
import { MODELS_DEV_URL, parseModelsDevModels, matchModelsDev } from "./modelsdev";
import type { Modality } from "@/lib/providers/registry";

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
  cacheWritePrice: number | null;
  capabilities: Capabilities;
  enabled: boolean; // default curation; admin choice overrides on re-sync
}

// Minimum context to count a model as "serious" for default curation.
const MIN_CONTEXT = 8000;
// Variant tags we never surface by default (routing/beta variants). `:free` is
// intentionally NOT here — free tiers are a wanted, cost-conscious option for a
// shared key, so they're curated in like any other model.
const NOISY_TAG = /:(extended|beta|thinking|nitro|online)/i;

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// ── Parsers (pure) ───────────────────────────────────────────

interface ORModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
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
    // OpenRouter also publishes `input_cache_write_1h`; we price the default
    // (5-minute) TTL because that's the only one we ever ask for.
    const cacheWrite = num(m.pricing?.input_cache_write);
    const ctx = m.context_length ?? null;
    const params = m.supported_parameters ?? [];
    const group = groupFromName(m.name, m.id);
    // OpenRouter's per-model input modalities: map their `file` → our `pdf`,
    // keep image/audio/video, drop `text` and anything unrecognized. This is
    // what gates native attachments precisely per model (see acceptsNativeFile).
    const inputMods = (m.architecture?.input_modalities ?? [])
      .map((x) => (x === "file" ? "pdf" : x))
      .filter((x): x is Modality => x === "image" || x === "pdf" || x === "audio" || x === "video");
    // `input != null` (not `> 0`): a known price of 0 means a genuinely free
    // model, which we keep; only a missing/unparseable price drops the row.
    const enabled =
      !NOISY_TAG.test(m.id) &&
      !isDatedSlug(m.id) &&
      input != null &&
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
      cacheWritePrice: cacheWrite,
      capabilities: {
        vision: inputMods.includes("image"),
        tools: params.includes("tools") || params.includes("tool_choice"),
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
        input: inputMods,
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
  cache_creation_input_token_cost?: number;
  max_input_tokens?: number;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
  supports_reasoning?: boolean;
  // Native input-modality signals — verified against the real LiteLLM price book.
  // No single field is complete (e.g. gemini-2.5-flash lists audio/video only in
  // `supported_modalities`, while gpt-4o-audio uses the per-flag), so we union
  // the array with the flags. `pdf` is never in the array — only `supports_pdf_input`.
  supported_modalities?: string[];
  supports_image_input?: boolean;
  supports_audio_input?: boolean;
  supports_pdf_input?: boolean;
  supports_video_input?: boolean;
}

/** Union LiteLLM's `supported_modalities` array with its per-flag booleans into
 *  our native input modalities, in a stable order. */
function liteLLMInputModalities(e: LLEntry): Modality[] {
  const sm = e.supported_modalities ?? [];
  const input: Modality[] = [];
  if (sm.includes("image") || e.supports_vision || e.supports_image_input) input.push("image");
  if (e.supports_pdf_input) input.push("pdf");
  if (sm.includes("audio") || e.supports_audio_input) input.push("audio");
  if (sm.includes("video") || e.supports_video_input) input.push("video");
  return input;
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
      cacheWritePrice: numv(e.cache_creation_input_token_cost),
      capabilities: {
        vision: !!e.supports_vision,
        tools: !!e.supports_function_calling,
        reasoning: !!e.supports_reasoning,
        ...((() => {
          const input = liteLLMInputModalities(e);
          return input.length ? { input } : {};
        })()),
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
export async function syncModelCatalog(): Promise<{ openrouter: number; litellm: number; modelsdev: number }> {
  let or = 0;
  let ll = 0;
  let md = 0;
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
    await upsertModels(parsed, { deferToOtherSources: true });
    ll = parsed.length;
  } catch (err) {
    console.error("[catalog] LiteLLM sync failed (non-fatal):", err);
  }
  // Models.dev last: enriches the rows the two sources just produced.
  try {
    md = await enrichFromModelsDev();
  } catch (err) {
    console.error("[catalog] Models.dev enrichment failed (non-fatal):", err);
  }
  priceCache.clear();
  livePriceCache.clear();
  livePriceBook = null; // fresh catalog supersedes the live-fetched fallback book
  contextCache.clear(); // was never cleared on sync — context windows could go stale
  effortsCache.clear(); // the merge above keeps them, but re-read rather than trust
  noReasoningCache.clear();
  console.log(`[catalog] synced ${or} OpenRouter + ${ll} LiteLLM models, enriched ${md} from Models.dev`);
  return { openrouter: or, litellm: ll, modelsdev: md };
}

const CHUNK = 500; // keep well under Postgres' parameter limit

async function upsertModels(list: CatalogModel[], opts?: { deferToOtherSources?: boolean }) {
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
    cacheWritePrice: m.cacheWritePrice === null ? null : String(m.cacheWritePrice),
    capabilities: m.capabilities,
    enabled: m.enabled,
    updatedAt: now,
  }));

  // Bulk upsert in chunks. One round-trip per chunk instead of per row keeps
  // a ~3k-model sync fast. Admin curation (enabled/featured) is preserved by
  // not touching those columns on conflict.
  const set = {
    source: sql`excluded.source`,
    displayName: sql`excluded.display_name`,
    group: sql`excluded."group"`,
    icon: sql`excluded.icon`,
    contextLength: sql`excluded.context_length`,
    inputPrice: sql`excluded.input_price`,
    outputPrice: sql`excluded.output_price`,
    cacheReadPrice: sql`excluded.cache_read_price`,
    cacheWritePrice: sql`excluded.cache_write_price`,
    // Refresh the synced capabilities but PRESERVE everything we LEARNED from a
    // provider rejection — no source reports these, so a plain
    // `excluded.capabilities` would wipe them on every sync and make every model
    // pay the negotiation retry again. Listed once, here: the previous version
    // carried `efforts` alone and dropped a second learned key in BOTH branches,
    // so such a memo held only until the next resync. `jsonb_strip_nulls` turns
    // an absent key into nothing, so a model that has taught us neither merges
    // `{}` and keeps `excluded.capabilities` verbatim.
    capabilities: sql`coalesce(excluded.capabilities, '{}'::jsonb) || coalesce(jsonb_strip_nulls(jsonb_build_object(
      'efforts', ${models.capabilities} -> 'efforts',
      'noReasoning', ${models.capabilities} -> 'noReasoning',
      'contextLength', ${models.capabilities} -> 'contextLength'
    )), '{}'::jsonb)`,
    updatedAt: sql`excluded.updated_at`,
  };
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const insert = db.insert(models).values(batch);
    if (opts?.deferToOtherSources) {
      // Secondary source (LiteLLM): still REFRESH the rows it already owns — a
      // plain onConflictDoNothing would freeze a row's metadata at its first
      // insert forever, so a later parser/price-book improvement (e.g. per-model
      // input modalities) never reaches an existing row even on a manual resync.
      // The `where` keeps the original intent: never clobber a row a richer
      // source (OpenRouter) already owns for the same id.
      await insert.onConflictDoUpdate({ target: models.id, set, setWhere: sql`${models.source} = excluded.source` });
    } else {
      await insert.onConflictDoUpdate({ target: models.id, set });
    }
  }
}

/**
 * Enrich existing catalog rows with Models.dev metadata (knowledge cutoff,
 * open-weights). Updates ONLY those two columns and ONLY rows that already
 * exist — never inserts, never touches price/curation. Matched by canonical
 * bare id so OpenRouter's dotted ids line up with Models.dev's hyphenated ones.
 * Returns the number of rows enriched. Never throws.
 */
export async function enrichFromModelsDev(): Promise<number> {
  let metas;
  try {
    metas = parseModelsDevModels(await fetchJson(MODELS_DEV_URL));
  } catch (err) {
    console.error("[catalog] Models.dev fetch failed (non-fatal):", err);
    return 0;
  }
  if (!metas.length) return 0;

  const existing = await db.select({ id: models.id }).from(models);
  const updates = matchModelsDev(metas, existing.map((r) => r.id));
  if (!updates.length) return 0;

  // Batched VALUES-join update: one round-trip per chunk instead of per row.
  // Casts pin the column types so an all-null first row can't be inferred wrong.
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const values = sql.join(
      batch.map((u) => sql`(${u.id}, ${u.cutoff}, ${u.openWeights})`),
      sql`, `,
    );
    await db.execute(sql`
      update ${models} as m
      set cutoff = v.cutoff::text, open_weights = v.ow::boolean
      from (values ${values}) as v(id, cutoff, ow)
      where m.id = v.id
    `);
  }
  return updates.length;
}

// ── Price lookup ─────────────────────────────────────────────

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Read-through caches. Bounded (a flood of distinct/mistyped ids can't grow them
// forever) and null is cached only briefly — without a short negative TTL a model
// priced AFTER the last sync would stay "unpriceable" (and thus blocked on the
// shared key) for the whole 12h sync interval. Positive hits live until the next
// sync clears the cache.
const CACHE_MAX = 5000;
const NULL_TTL_MS = 60_000;
type CacheEntry<T> = { v: T; exp: number };
function cacheGet<T>(m: Map<string, CacheEntry<T>>, key: string): { hit: true; v: T } | { hit: false } {
  const e = m.get(key);
  if (e && (e.exp === Infinity || e.exp > Date.now())) return { hit: true, v: e.v };
  return { hit: false };
}
function cacheSet<T>(m: Map<string, CacheEntry<T>>, key: string, v: T, isNull: boolean): void {
  if (m.size > CACHE_MAX) m.clear();
  m.set(key, { v, exp: isNull ? Date.now() + NULL_TTL_MS : Infinity });
}

const priceCache = new Map<string, CacheEntry<ModelPrice | null>>();

/**
 * Resolve a model's per-token price from the catalog. Tries the exact id,
 * then the provider-stripped id (e.g. "anthropic/claude-…" → "claude-…").
 * Cached in-process; cache is cleared on each sync.
 */
export async function getModelPrice(modelId: string): Promise<ModelPrice | null> {
  const cached = cacheGet(priceCache, modelId);
  if (cached.hit) return cached.v;
  const stripped = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  const rows = await db
    .select({
      id: models.id,
      inputPrice: models.inputPrice,
      outputPrice: models.outputPrice,
      cacheReadPrice: models.cacheReadPrice,
      cacheWritePrice: models.cacheWritePrice,
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
        // No multiplier is assumed anywhere: both price books publish the real
        // cache-write rate. When a source omits it, fall back to the BASE INPUT
        // rate — a cache write is never cheaper than plain input, so that
        // under-states rather than invents, and it is strictly better than the
        // zero these tokens used to be charged.
        cacheWrite:
          exact.cacheWritePrice != null ? parseFloat(exact.cacheWritePrice) : parseFloat(exact.inputPrice),
      }
    : null;
  cacheSet(priceCache, modelId, price, price === null);
  return price;
}

// Best-effort LIVE price when the synced catalog is missing a model — e.g. a
// brand-new or free OpenRouter model the periodic sync hasn't picked up yet.
// Hits OpenRouter's public price book directly (works unauthenticated) and caches
// the parsed book for a few minutes so a flurry of turns shares one fetch. Returns
// null when the model isn't there either (or the fetch fails); the caller then
// lets the turn run unpriced rather than blocking it.
const LIVE_PRICE_TTL_MS = 5 * 60_000;
let livePriceBook: { at: number; byId: Map<string, ModelPrice> } | null = null;
const livePriceCache = new Map<string, CacheEntry<ModelPrice | null>>();

export async function getLiveModelPrice(modelId: string): Promise<ModelPrice | null> {
  const cached = cacheGet(livePriceCache, modelId);
  if (cached.hit) return cached.v;
  try {
    if (!livePriceBook || Date.now() - livePriceBook.at > LIVE_PRICE_TTL_MS) {
      const byId = new Map<string, ModelPrice>();
      for (const m of parseOpenRouterModels(await fetchJson(OPENROUTER_MODELS_URL))) {
        if (m.inputPrice == null) continue; // no usable price — skip
        byId.set(m.id, {
          input: m.inputPrice,
          output: m.outputPrice ?? 0,
          cacheRead: m.cacheReadPrice ?? 0,
          cacheWrite: m.cacheWritePrice ?? m.inputPrice,
        });
      }
      livePriceBook = { at: Date.now(), byId };
    }
    const stripped = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
    const price =
      livePriceBook.byId.get(modelId) ??
      (stripped !== modelId
        ? [...livePriceBook.byId].find(([id]) => id === stripped || id.endsWith(`/${stripped}`))?.[1] ?? null
        : null);
    cacheSet(livePriceCache, modelId, price, price === null);
    return price;
  } catch {
    return null;
  }
}

const contextCache = new Map<string, CacheEntry<number | null>>();

/** The window this deployment has seen the model enforce, if any (see
 *  rememberModelContextLength). Read from the `capabilities` jsonb rather than the
 *  synced column so a re-sync cannot overwrite it. */
export function learnedContextLength(capabilities: unknown): number | null {
  const v = (capabilities as { contextLength?: unknown } | null)?.contextLength;
  return typeof v === "number" && v > 0 ? v : null;
}

/**
 * The model's context window (tokens): what an overflow has TAUGHT us if anything
 * has, else the synced catalog's figure, else null (a custom/local backend the
 * catalog never heard of) — in which case the budget falls back to a default and
 * the first overflow teaches the real number. Same id-matching as getModelPrice
 * (exact, then provider-stripped). Cached in-process.
 */
export async function getModelContextLength(modelId: string): Promise<number | null> {
  const cached = cacheGet(contextCache, modelId);
  if (cached.hit) return cached.v;
  const rows = await db
    .select({ id: models.id, contextLength: models.contextLength, capabilities: models.capabilities })
    .from(models)
    .where(idMatch(modelId))
    .limit(5);

  const exact = rows.find((r) => r.id === modelId);
  const ctx =
    learnedContextLength(exact?.capabilities) ??
    rows.map((r) => learnedContextLength(r.capabilities)).find((v) => v !== null) ??
    exact?.contextLength ??
    rows.find((r) => r.contextLength != null)?.contextLength ??
    null;
  cacheSet(contextCache, modelId, ctx, ctx === null);
  return ctx;
}

/**
 * Remember the window a model just enforced, so the overflow that revealed it is
 * paid ONCE per model: from the next turn the budget compacts against the real
 * figure instead of the catalog's (or the default's) guess. Same shape and
 * bargain as rememberModelEfforts — merged into `capabilities`, preserved across
 * a re-sync by the merge in upsertModels, and a minimal disabled row is inserted
 * for an off-catalog model so it stops re-learning.
 */
export async function rememberModelContextLength(modelId: string, source: string, contextLength: number): Promise<void> {
  const merge = sql`coalesce(${models.capabilities}, '{}'::jsonb) || ${JSON.stringify({ contextLength })}::jsonb`;
  const updated = await db
    .update(models)
    .set({ capabilities: merge, updatedAt: new Date() })
    .where(idMatch(modelId))
    .returning({ id: models.id });
  if (!updated.length) {
    await db
      .insert(models)
      .values({
        id: modelId,
        source,
        displayName: modelId,
        contextLength,
        capabilities: { vision: false, tools: true, reasoning: false, contextLength },
        enabled: false,
      })
      .onConflictDoNothing();
  }
  contextCache.delete(modelId);
}

// ── Learned reasoning-effort enums ───────────────────────────

const effortsCache = new Map<string, CacheEntry<string[] | null>>();

/**
 * Fuzzy id match against the catalog: exact, then provider-stripped, then any
 * row whose id ends in `/<stripped>` (a bare "glm-5.2" from a custom endpoint
 * against OpenRouter's "z-ai/glm-5.2").
 *
 * Exported because a stored model ref and a catalog row disagree about the
 * vendor prefix in BOTH directions — a ref can carry one the row lacks and vice
 * versa — so all three clauses are needed, and a caller that writes only the two
 * obvious ones silently fails to resolve exactly the models this exists for.
 * Anyone looking a model id up in `models` should call this rather than rebuild
 * it; there were five hand-rolled copies before it had a name worth importing.
 */
export const idMatch = (modelId: string) => {
  const stripped = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  return or(eq(models.id, modelId), eq(models.id, stripped), like(models.id, `%/${stripped}`));
};

/**
 * The `reasoning_effort` values this model is known to accept, learned from a
 * previous rejection (see parseAllowedEfforts). Null = not known yet, in which
 * case the adapter sends its best guess and the runner negotiates on the 400.
 */
export async function getModelEfforts(modelId: string): Promise<string[] | null> {
  const cached = cacheGet(effortsCache, modelId);
  if (cached.hit) return cached.v;
  const rows = await db
    .select({ id: models.id, capabilities: models.capabilities })
    .from(models)
    .where(idMatch(modelId))
    .limit(5);
  const withEfforts = rows.filter((r) => Array.isArray((r.capabilities as { efforts?: unknown })?.efforts));
  const row = withEfforts.find((r) => r.id === modelId) ?? withEfforts[0];
  const efforts = (row?.capabilities as { efforts?: string[] })?.efforts ?? null;
  cacheSet(effortsCache, modelId, efforts, efforts === null);
  return efforts;
}

/**
 * Remember what a model told us it accepts, so the negotiation costs ONE request
 * per model rather than one per turn — and so the picker can offer exactly the
 * levels that model really has.
 *
 * Stored inside the existing `capabilities` jsonb (no migration) and merged, not
 * replaced, so a catalog re-sync can't wipe it (see the `set` in upsertModels).
 * A model served by a custom gateway may not be in the catalog at all; rather
 * than re-learning forever, we insert a minimal row for it — `enabled: false`, so
 * it stays out of the curated picker list and only enriches metadata.
 */
export async function rememberModelEfforts(modelId: string, source: string, efforts: string[]): Promise<void> {
  const merge = sql`coalesce(${models.capabilities}, '{}'::jsonb) || ${JSON.stringify({ efforts })}::jsonb`;
  const updated = await db
    .update(models)
    .set({ capabilities: merge, updatedAt: new Date() })
    .where(idMatch(modelId))
    .returning({ id: models.id });
  if (!updated.length) {
    await db
      .insert(models)
      .values({
        id: modelId,
        source,
        displayName: modelId,
        // It just reasoned for us, so `reasoning` is a fact here, not a guess.
        capabilities: { vision: false, tools: true, reasoning: true, efforts },
        enabled: false,
      })
      .onConflictDoNothing();
  }
  effortsCache.delete(modelId);
}

// ── Learned "this model cannot reason at all" ────────────────

const noReasoningCache = new Map<string, CacheEntry<boolean>>();

/**
 * True when this model has already told us it does not accept reasoning knobs at
 * all. Read before the first request of a turn so a model that cannot reason
 * never pays the rejected round-trip again.
 */
export async function getModelCannotReason(modelId: string): Promise<boolean> {
  const cached = cacheGet(noReasoningCache, modelId);
  if (cached.hit) return cached.v;
  const rows = await db
    .select({ id: models.id, capabilities: models.capabilities })
    .from(models)
    .where(idMatch(modelId))
    .limit(5);
  // Same shape as getModelEfforts: an id can resolve to rows from several
  // sources, so prefer the exact id and otherwise take whichever row learned it.
  const withFlag = rows.filter((r) => (r.capabilities as { noReasoning?: unknown })?.noReasoning === true);
  const flag = (withFlag.find((r) => r.id === modelId) ?? withFlag[0]) !== undefined;
  cacheSet(noReasoningCache, modelId, flag, !flag);
  return flag;
}

/**
 * Remember that a model rejected reasoning outright, so the discovery costs ONE
 * request per model instead of one per turn — the same bargain as
 * rememberModelEfforts, whose neighbouring branch made it and this one did not.
 *
 * Written as a learned-only key so it cannot be confused with the `reasoning`
 * flag a source reports, and preserved across a catalog re-sync by the merge in
 * upsertModels.
 */
export async function rememberModelCannotReason(modelId: string, source: string): Promise<void> {
  const merge = sql`coalesce(${models.capabilities}, '{}'::jsonb) || ${JSON.stringify({ noReasoning: true })}::jsonb`;
  const updated = await db
    .update(models)
    .set({ capabilities: merge, updatedAt: new Date() })
    .where(idMatch(modelId))
    .returning({ id: models.id });
  if (!updated.length) {
    await db
      .insert(models)
      .values({
        id: modelId,
        source,
        displayName: modelId,
        // It just refused to reason, so `reasoning: false` is a fact here.
        capabilities: { vision: false, tools: true, reasoning: false, noReasoning: true },
        enabled: false,
      })
      .onConflictDoNothing();
  }
  noReasoningCache.delete(modelId);
}
