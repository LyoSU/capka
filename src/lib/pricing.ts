/**
 * Static model→price catalog. Prices are USD per 1,000,000 tokens.
 *
 * Matched by longest prefix so a specific id like `claude-3-5-haiku-20241022`
 * resolves to `claude-3-5-haiku` and never to the broader `claude-3` family.
 * Cached input tokens are billed at `CACHE_READ_RATE` of the input price
 * (Anthropic/OpenAI prompt-cache reads are ~10% of the base input rate).
 *
 * This is a pragmatic snapshot for cost estimation, not a billing source of
 * truth — keep it roughly current; unknown models simply return `null`.
 */
export interface ModelPrice {
  input: number;
  output: number;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export const CACHE_READ_RATE = 0.1;

export const PRICING: Record<string, ModelPrice> = {
  // ── Anthropic ──────────────────────────────────────────────
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4": { input: 1, output: 5 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  // ── OpenAI ─────────────────────────────────────────────────
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
};

// Longest keys first so prefix matching prefers the most specific entry.
const SORTED_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

function priceFor(model: string): ModelPrice | null {
  // Strip a leading provider segment (e.g. "anthropic/claude-opus-4-8").
  const id = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  for (const key of SORTED_KEYS) {
    if (id.startsWith(key)) return PRICING[key];
  }
  return null;
}

/**
 * Estimated USD cost for a model run, or `null` if the model is unknown.
 */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  return (
    (input * price.input) / 1_000_000 +
    (output * price.output) / 1_000_000 +
    (cached * price.input * CACHE_READ_RATE) / 1_000_000
  );
}
