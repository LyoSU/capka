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
 * Estimated USD cost for a run, sourced from the synced model catalog (never
 * hardcoded). Returns null when the model has no known price (e.g. local
 * Ollama models, or before the first catalog sync).
 */
export async function costUsd(modelId: string, usage: TokenUsage): Promise<number | null> {
  const price = await getModelPrice(modelId);
  if (!price) return null;
  return computeCost(price, usage);
}
