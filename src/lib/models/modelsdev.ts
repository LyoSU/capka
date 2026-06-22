/**
 * Models.dev — a community-curated, provider-agnostic model database
 * (MIT-licensed, https://github.com/sst/models.dev). We use it ONLY to enrich
 * our existing catalog with metadata our live sources (OpenRouter, LiteLLM)
 * don't carry: knowledge cutoff and open-weights status. It never sets prices
 * or curation. Pure parsing/matching — no I/O, so it is unit-tested directly.
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** One enrichable model as Models.dev describes it (bare, provider-native id). */
export interface ModelsDevMeta {
  bareId: string;
  cutoff: string | null; // Models.dev "knowledge" field, e.g. "2025-03"
  openWeights: boolean | null;
}

/** A resolved write target: enrich the row with this catalog id. */
export interface ModelsDevUpdate {
  id: string;
  cutoff: string | null;
  openWeights: boolean | null;
}

interface MDModel {
  id?: string;
  knowledge?: string;
  open_weights?: boolean;
}
interface MDProvider {
  models?: Record<string, MDModel>;
}

/**
 * Flatten Models.dev's `{ provider: { models: { id: {...} } } }` shape into a
 * flat list. Drop entries with nothing to contribute (no cutoff and no
 * open-weights flag) so we never issue a pointless UPDATE.
 */
export function parseModelsDevModels(raw: unknown): ModelsDevMeta[] {
  const providers = (raw as Record<string, MDProvider>) ?? {};
  if (typeof providers !== "object" || providers === null) return [];
  const out: ModelsDevMeta[] = [];
  for (const provider of Object.values(providers)) {
    const models = provider?.models;
    if (!models || typeof models !== "object") continue;
    for (const [key, m] of Object.entries(models)) {
      const bareId = m?.id || key;
      if (!bareId) continue;
      const cutoff = typeof m?.knowledge === "string" && m.knowledge.trim() ? m.knowledge.trim() : null;
      const openWeights = typeof m?.open_weights === "boolean" ? m.open_weights : null;
      if (cutoff === null && openWeights === null) continue;
      out.push({ bareId, cutoff, openWeights });
    }
  }
  return out;
}

/**
 * Canonicalize an id so OpenRouter's dotted, provider-prefixed ids
 * ("anthropic/claude-opus-4.1") and Models.dev's hyphenated bare ids
 * ("claude-opus-4-1") collapse to the same key. Strip the provider prefix,
 * lowercase, and treat "." / "_" / "-" as one separator.
 */
export function canonId(id: string): string {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return bare
    .toLowerCase()
    .replace(/[._-]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Resolve Models.dev metas onto the catalog ids we actually have. For each
 * existing id, look up its canonical key; if Models.dev describes it, emit an
 * update carrying the real (full) catalog id so the writer can target it by PK.
 */
export function matchModelsDev(metas: ModelsDevMeta[], existingIds: string[]): ModelsDevUpdate[] {
  const byCanon = new Map<string, ModelsDevMeta>();
  for (const meta of metas) {
    const key = canonId(meta.bareId);
    if (!byCanon.has(key)) byCanon.set(key, meta); // first wins; stable
  }
  const out: ModelsDevUpdate[] = [];
  for (const id of existingIds) {
    const meta = byCanon.get(canonId(id));
    if (meta) out.push({ id, cutoff: meta.cutoff, openWeights: meta.openWeights });
  }
  return out;
}
