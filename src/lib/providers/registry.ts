/**
 * The single source of truth for *which* LLM providers exist and how the UI
 * should present + configure each one. Kept free of heavy SDK imports so client
 * components (setup wizard, connections form) can import it without pulling the
 * AI SDKs into the browser bundle. `index.ts` re-exports these and adds the
 * server-only `getModel()` factory.
 */

// Gateways (LiteLLM proxy, OpenRouter) are listed first: routing every backend
// through one OpenAI-compatible endpoint is the recommended, most scalable
// setup — one adapter, one model list, unified cost/limits. The direct
// providers remain as simple presets.
export const PROVIDERS = ["litellm", "openrouter", "openai", "anthropic", "ollama"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ProviderMeta {
  /** Human-facing name shown in dropdowns and provider cards. */
  label: string;
  /** One-liner shown under the option to explain when to pick it. */
  blurb: string;
  /** Surface this as the suggested choice in setup. */
  recommended?: boolean;
  /** Slug for `iconForSlug()` — keeps brand icons consistent everywhere. */
  iconSlug: string;
  /** API key required to connect (local Ollama isn't). */
  requiresKey: boolean;
  /** Provider is reached via a base URL the user must supply. */
  requiresBaseUrl: boolean;
  /** Sensible default for the base URL field. */
  defaultBaseUrl?: string;
  /** Placeholder for the base URL field. */
  baseUrlPlaceholder?: string;
  /**
   * Whether `/api/models` serves a synced, browseable catalog (OpenRouter).
   * Everyone else lists live from the provider's own `/v1/models` (or tags).
   */
  hasCatalog: boolean;
  /**
   * Whether the provider's chat API accepts a PDF as an inline
   * `{type:"file"}` content block. The first-party APIs and the OpenRouter
   * gateway do; generic OpenAI-compatible endpoints (Z.ai, vLLM, a LiteLLM
   * proxy in front of an arbitrary backend) and Ollama reject it with a
   * `messages[N].content[k].type` error, so PDFs degrade to tool-only there.
   * Images use the near-universal `image_url` block and aren't gated.
   */
  acceptsInlinePdf: boolean;
}

export const PROVIDER_META: Record<ProviderName, ProviderMeta> = {
  litellm: {
    label: "OpenAI-compatible",
    blurb: "Any OpenAI-style /v1 endpoint — LiteLLM, vLLM, or your own gateway in front of any provider.",
    recommended: true,
    iconSlug: "litellm",
    requiresKey: true,
    requiresBaseUrl: true,
    baseUrlPlaceholder: "https://your-litellm-host/v1",
    hasCatalog: false,
    // Generic OpenAI-compatible endpoint — the backend is unknown, so we can't
    // assume it understands the `{type:"file"}` PDF block. Degrade to tool-only.
    acceptsInlinePdf: false,
  },
  openrouter: {
    label: "OpenRouter",
    blurb: "Hosted gateway to hundreds of models with one key.",
    iconSlug: "openrouter",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: true,
    acceptsInlinePdf: true,
  },
  openai: {
    label: "OpenAI",
    blurb: "Connect directly to OpenAI.",
    iconSlug: "openai",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: false,
    acceptsInlinePdf: true,
  },
  anthropic: {
    label: "Anthropic",
    blurb: "Connect directly to Claude.",
    iconSlug: "anthropic",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: false,
    acceptsInlinePdf: true,
  },
  ollama: {
    label: "Ollama",
    blurb: "Run open models locally.",
    iconSlug: "ollama",
    requiresKey: false,
    requiresBaseUrl: true,
    defaultBaseUrl: "http://localhost:11434/api",
    baseUrlPlaceholder: "http://localhost:11434/api",
    hasCatalog: false,
    acceptsInlinePdf: false,
  },
};

/** Convenience list for rendering provider options with labels + blurbs. */
export const PROVIDER_OPTIONS: {
  value: ProviderName;
  label: string;
  blurb: string;
  iconSlug: string;
  recommended: boolean;
}[] = PROVIDERS.map((value) => ({
  value,
  label: PROVIDER_META[value].label,
  blurb: PROVIDER_META[value].blurb,
  iconSlug: PROVIDER_META[value].iconSlug,
  recommended: !!PROVIDER_META[value].recommended,
}));

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function providerLabel(provider: string): string {
  return isProviderName(provider) ? PROVIDER_META[provider].label : provider;
}

/**
 * Whether a provider's chat API accepts this file as a native, inline content
 * block. Used to gate `injectNativeFiles`: anything this returns `false` for is
 * left in /workspace for the agent to open with sandbox tools (tool-only)
 * instead of being pushed into the message `content` array.
 *
 * - Images → the near-universal `image_url` block, accepted everywhere a vision
 *   model exists (a non-vision model erroring is a model-choice problem, not an
 *   API-shape one, so we don't gate it here).
 * - PDF → the AI SDK serializes it as an OpenAI-specific `{type:"file"}` block;
 *   gated by each provider's declared `acceptsInlinePdf` capability. An unknown
 *   provider falls to the safe side (tool-only) so it never reintroduces the
 *   `messages[N].content[k].type` rejection.
 */
export function providerAcceptsNativeFile(provider: string, mimeType: string): boolean {
  if (mimeType.startsWith("image/")) return true;
  if (mimeType === "application/pdf") {
    return isProviderName(provider) && PROVIDER_META[provider].acceptsInlinePdf;
  }
  return false;
}

// ── Model id encoding ──────────────────────────────────────────────────────
//
// A model is stored as a bare model id (e.g. `openai/gpt-5.2` for OpenRouter,
// `gpt-5.2` for OpenAI direct). The provider is config state, not part of the
// id — `resolveUserModelInfo` derives it from the active provider config. For
// backward compatibility, older values encoded as `provider:modelId` are still
// understood: `parseModelId` splits on the FIRST colon (the modelId part may
// contain a slash but never a colon) and falls back to a caller-supplied
// provider when there is no colon. Centralized here so the picker, the
// resolver, and the default-model logic never drift on the format.

export function parseModelId(
  value: string,
  fallbackProvider?: string,
): { provider: string | undefined; modelId: string } {
  const idx = value.indexOf(":");
  if (idx === -1) return { provider: fallbackProvider, modelId: value };
  return { provider: value.slice(0, idx), modelId: value.slice(idx + 1) };
}

// ── Config-scoped model refs ────────────────────────────────────────────────
//
// With several provider configs usable at once (two LiteLLM proxies can list
// the very same `glm-5.2`), the bare model id is ambiguous. A *ref* prefixes the
// owning config's id — `${configId}:${modelId}` — so the resolver routes to the
// exact config and usage is attributed to it. configIds are nanoids (alphabet
// `A-Za-z0-9_-`, never a colon), so the FIRST colon is always the boundary,
// even when the modelId itself carries colons (e.g. OpenRouter's `…:free`).

/** Build a config-scoped model ref from a config id and a bare model id. */
export function encodeModelRef(configId: string, modelId: string): string {
  return `${configId}:${modelId}`;
}

/** Split a value into a candidate config id + the model id. The caller decides
 *  whether `configId` actually names a known config (DB-authoritative) — a
 *  legacy `provider:modelId` or a bare id lands here too, so it's only a hint. */
export function splitModelRef(value: string): { configId: string | null; modelId: string } {
  const idx = value.indexOf(":");
  if (idx === -1) return { configId: null, modelId: value };
  return { configId: value.slice(0, idx), modelId: value.slice(idx + 1) };
}

/** Short, human-friendly model name from any encoded or bare value. */
export function displayModelName(value: string): string {
  if (!value) return "select model";
  const { modelId } = parseModelId(value);
  return modelId.includes("/") ? modelId.split("/").pop()! : modelId;
}
