import { getModelPrice, type ModelPrice } from "./models/catalog";

export interface TokenUsage {
  /** Uncached input. EXCLUDES both `cachedInputTokens` and `cacheWriteTokens`. */
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt-cache READS, billed at the discounted cacheRead rate. */
  cachedInputTokens?: number;
  /** Prompt-cache WRITES, billed ABOVE base input. Distinct from both of the
   *  above: a provider that reports them (Anthropic-style explicit caching) has
   *  already excluded them from `inputTokens`, so pricing them here adds the
   *  charge that was missing rather than double-counting one that was there. */
  cacheWriteTokens?: number;
  /** The part of `cacheWriteTokens` written with a 1-hour TTL — a SUBSET, not a
   *  fifth bucket, so every token total stays what it was and only the price of
   *  these differs. Anthropic bills a 1h write at 2x base input against 1.25x for
   *  the 5-minute default, and reports the split per request. */
  cacheWrite1hTokens?: number;
}

/** A 1h cache write over a 5-minute one: 2x / 1.25x base input. Applied to the
 *  catalog's own 5-minute rate rather than stored as a second price — the models
 *  table has one write column, and OpenRouter's `input_cache_write_1h` and
 *  LiteLLM's `cache_creation_input_token_cost_above_1hr` are 1.6x their 5-minute
 *  rate on every Anthropic-served Claude they list (only resellers deviate). */
export const CACHE_WRITE_1H_FACTOR = 2 / 1.25;

/** Pure cost math from per-token prices. */
export function computeCost(price: ModelPrice, usage: TokenUsage): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  // Clamped to the writes it is a part of, so a malformed report can't bill more
  // write tokens than were written.
  const hour = Math.min(usage.cacheWrite1hTokens ?? 0, cacheWrite);
  return (
    input * price.input +
    output * price.output +
    cached * price.cacheRead +
    (cacheWrite - hour) * price.cacheWrite +
    hour * price.cacheWrite * CACHE_WRITE_1H_FACTOR
  );
}

/**
 * Normalize an AI SDK usage object into our billable split: `inputTokens`
 * EXCLUDES the cached portion (billed separately at the cache-read rate), so
 * cost is never double-counted. This is the same convention the runner applies
 * to a stream's totalUsage — centralized here so the auxiliary calls (title,
 * memory extraction) account for spend identically. Returns undefined when the
 * provider reported no usage (e.g. a mocked call in tests).
 */
export function toTokenUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        /** The SDK's normalized split, when the provider reported one. `noCache`
         *  already excludes BOTH cache reads and cache writes, so preferring it
         *  keeps the three buckets disjoint; the subtraction below is the fallback
         *  for providers that report only a total. */
        inputTokenDetails?: { noCacheTokens?: number; cacheWriteTokens?: number };
      }
    | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  return {
    inputTokens:
      usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cached - cacheWrite),
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: cached,
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/**
 * Estimated USD cost for a run, sourced from the synced model catalog (never
 * hardcoded). Returns null when the model has no known price (e.g. local
 * Ollama models, or before the first catalog sync).
 */
export async function costUsd(modelId: string, usage: TokenUsage): Promise<number | null> {
  const price = await getModelPrice(modelId);
  if (!price) return null;
  return computeCost(price, usage);
}
