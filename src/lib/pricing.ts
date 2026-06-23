import { getModelPrice, type ModelPrice } from "./models/catalog";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Pure cost math from per-token prices. */
export function computeCost(price: ModelPrice, usage: TokenUsage): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  return input * price.input + output * price.output + cached * price.cacheRead;
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
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage.inputTokens ?? 0) - cached),
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: cached,
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
