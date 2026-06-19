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
  },
  openrouter: {
    label: "OpenRouter",
    blurb: "Hosted gateway to hundreds of models with one key.",
    iconSlug: "openrouter",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: true,
  },
  openai: {
    label: "OpenAI",
    blurb: "Connect directly to OpenAI.",
    iconSlug: "openai",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: false,
  },
  anthropic: {
    label: "Anthropic",
    blurb: "Connect directly to Claude.",
    iconSlug: "anthropic",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: false,
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

/** Short, human-friendly model name from any encoded or bare value. */
export function displayModelName(value: string): string {
  if (!value) return "select model";
  const { modelId } = parseModelId(value);
  return modelId.includes("/") ? modelId.split("/").pop()! : modelId;
}
