/**
 * How hard the model should think, expressed ONCE in the app's own vocabulary
 * and translated to each provider's wire format here.
 *
 * Why a canonical scale instead of passing a provider value around: there is no
 * portable `reasoning_effort` value. Verified enums in the wild —
 *   Kimi K3 (Moonshot):  low | high | max
 *   Groq / Qwen:         none | default            ← nothing else
 *   Groq / GPT-OSS:      low | medium | high
 *   OpenAI GPT-5.x:      none | minimal | low | medium | high  (+xhigh on codex-max)
 *   xAI Grok 4.5:        low | medium | high       (cannot be disabled)
 * — and the intersection of those sets is EMPTY. Any hardcoded string is
 * therefore a 400 waiting for the next model. So the product picks an intent
 * ("think a bit" / "think hard") and `reasoningParams` picks the wire value that
 * the specific model actually accepts, from the enum learned at runtime (see
 * parseAllowedEfforts + models.capabilities.efforts).
 *
 * Anthropic/Google/Bedrock have no enum at all — they take a token budget — so
 * for them the intent maps to a number and this whole problem doesn't exist.
 */

/** Ordered weakest → strongest. `off` is the absence of a request, not a value. */
export const THINK_AMOUNTS = ["off", "brief", "balanced", "deep"] as const;
export type ThinkAmount = (typeof THINK_AMOUNTS)[number];
/** Any amount that actually asks for reasoning. */
export type ThinkOn = Exclude<ThinkAmount, "off">;

/** Matches the historical hardcoded behaviour (medium / 4000 budget tokens). */
export const DEFAULT_THINK_AMOUNT: ThinkAmount = "balanced";

export function parseThinkAmount(value: unknown): ThinkAmount {
  return (THINK_AMOUNTS as readonly string[]).includes(value as string)
    ? (value as ThinkAmount)
    : DEFAULT_THINK_AMOUNT;
}

/**
 * Every `reasoning_effort` token we've seen a provider accept, ordered by how
 * much thinking it buys. Used to sort a model's advertised enum, so an unknown
 * token can never be mistaken for an intensity — it's just passed through
 * verbatim when it's the only thing on offer.
 *
 * `default` (Groq's Qwen models) means "reasoning on, intensity unspecified",
 * which sits naturally in the middle of the scale.
 */
const EFFORT_SCALE = ["none", "minimal", "low", "default", "medium", "high", "xhigh", "max"] as const;

/** Fallback when a model's enum is unknown — the values every enum-style backend
 *  we know accepts *except* the two outliers (Groq/Qwen, Kimi), which teach us
 *  their enum on the first rejection and are then served from `efforts`. */
const GUESS: Record<ThinkOn, string> = { brief: "low", balanced: "medium", deep: "high" };

/**
 * Providers that take a token budget rather than an enum. They can express every
 * stop of the scale, always, so the UI never has to hide one.
 */
const BUDGET_PROVIDERS = new Set(["anthropic", "bedrock", "google", "vertex"]);
/**
 * Providers that take an OpenAI-style `reasoning_effort` string. `openai`/`azure`
 * pass it through the Responses API alongside the summary knob; the rest are the
 * OpenAI-compatible family (a bare gateway included), where the namespace equals
 * the provider name in getModel. Anything not listed here (today: `ollama`) has
 * no reasoning knob at all and gets no control.
 */
const EFFORT_PROVIDERS = new Set([
  "openai", "azure", "openrouter", "litellm", "deepseek", "mistral", "xai", "groq", "zhipu",
]);

/** Thinking budget in tokens. 1024 is Anthropic's documented minimum, so `brief`
 *  can't be lowered further; `deep` stays well under a typical output cap so the
 *  model can't spend the whole reply on thinking. */
const BUDGET: Record<ThinkOn, number> = { brief: 1024, balanced: 4000, deep: 16000 };

/**
 * Which wire effort each stop maps to for a model whose enum is `allowed`.
 *
 * Spread by POSITION, not by name: take the accepted values that mean "on",
 * sort them by intensity, and hand out the weakest / middle / strongest. That
 * way the mapping is always distinct and always legal, whatever the enum —
 * `[low, high, max]` yields low/high/max, `[minimal, low, medium, high]` yields
 * minimal/medium/high, and a single-value enum like Groq's `default` collapses
 * to one stop instead of three stops that all do the same thing.
 *
 * Returns only the stops the model can actually distinguish, so the UI can
 * render exactly those and make an invalid value unpickable.
 */
export function effortSpread(allowed?: readonly string[] | null): Partial<Record<ThinkOn, string>> {
  if (!allowed?.length) return { ...GUESS };
  const on = allowed
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v && v !== "none")
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => EFFORT_SCALE.indexOf(a as never) - EFFORT_SCALE.indexOf(b as never));
  if (!on.length) return {}; // the model can only be asked NOT to think
  if (on.length === 1) return { balanced: on[0] };
  // Two values are extremes, not a spectrum — a middle stop would duplicate one.
  if (on.length === 2) return { brief: on[0], deep: on[1] };
  return { brief: on[0], balanced: on[Math.round((on.length - 1) / 2)], deep: on[on.length - 1] };
}

/**
 * The stops to offer for this model. `off` is always offered because it is the
 * ABSENCE of the parameter — omitting a knob is legal on every provider, which
 * is what makes "don't think" the one setting that can never 400. A provider
 * with no knob at all returns [] and the control is hidden entirely.
 */
export function availableAmounts(provider: string, allowed?: readonly string[] | null): ThinkAmount[] {
  if (BUDGET_PROVIDERS.has(provider)) return [...THINK_AMOUNTS];
  if (!EFFORT_PROVIDERS.has(provider)) return [];
  const spread = effortSpread(allowed);
  return ["off", ...(["brief", "balanced", "deep"] as const).filter((a) => spread[a])];
}

/** Snap a stored/requested amount onto what this model can do, so a chat that
 *  was set to `deep` on one model doesn't send an illegal value after a switch. */
export function clampAmount(amount: ThinkAmount, available: readonly ThinkAmount[]): ThinkAmount {
  if (!available.length) return "off";
  if (available.includes(amount)) return amount;
  // Nearest by intensity, falling back to the strongest thing on offer.
  const want = THINK_AMOUNTS.indexOf(amount);
  return [...available].sort(
    (a, b) => Math.abs(THINK_AMOUNTS.indexOf(a) - want) - Math.abs(THINK_AMOUNTS.indexOf(b) - want),
  )[0];
}

/**
 * Per-provider knobs that ask the model to reason AND surface that reasoning in
 * the stream. Without them the provider reasons silently — or not at all — so
 * the SDK never emits `reasoning-delta` and the UI's thinking block stays empty.
 *
 * `off` (and any provider with no knob) returns undefined: we send nothing.
 *
 * Visibility caveat: OpenAI only returns a reasoning *summary* over the
 * Responses API ("openai" provider). Through an OpenAI-compatible gateway
 * ("litellm", Chat Completions) the summary is visible only if the upstream
 * model echoes `reasoning_content` (Anthropic/DeepSeek/Kimi do; OpenAI hides it).
 */
export function reasoningParams(
  provider: string,
  amount: ThinkAmount,
  allowed?: readonly string[] | null,
): Record<string, Record<string, unknown>> | undefined {
  if (amount === "off") return undefined;
  const budget = BUDGET[amount];
  switch (provider) {
    case "anthropic":
      // The SDK sets max_tokens to fit the budget — don't cap it ourselves.
      return { anthropic: { thinking: { type: "enabled", budgetTokens: budget } } };
    case "bedrock":
      // Converse reasoningConfig — Claude/Nova reasoning models stream
      // reasoningContent; non-reasoning models trip the retry-without path.
      return { bedrock: { reasoningConfig: { type: "enabled", budgetTokens: budget } } };
    case "google":
    case "vertex":
      // Gemini (direct or via Vertex — same model class, same "google"
      // namespace): includeThoughts streams a thought summary into
      // reasoning-delta. (Google Search grounding is a provider-executed TOOL in
      // this SDK, not a providerOption, so it's wired into the tool set via
      // providerNativeTools(), not here.)
      return { google: { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } } };
    default: {
      if (!EFFORT_PROVIDERS.has(provider)) return undefined;
      const effort = effortSpread(allowed)[amount];
      if (!effort) return undefined; // this stop isn't expressible on this model
      // OpenRouter wraps the effort in its own normalizing object; the Responses
      // API pairs it with the summary knob (azure reads the "azure" namespace,
      // falling back to "openai"); everyone else takes the bare string, with the
      // namespace matching the provider `name` in getModel.
      if (provider === "openrouter") return { openrouter: { reasoning: { enabled: true, effort } } };
      if (provider === "openai" || provider === "azure") {
        return { [provider]: { reasoningSummary: "auto", reasoningEffort: effort } };
      }
      return { [provider]: { reasoningEffort: effort } };
    }
  }
}
