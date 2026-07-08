/**
 * The single source of truth for *which* LLM providers exist and how the UI
 * should present + configure each one. Kept free of heavy SDK imports so client
 * components (setup wizard, connections form) can import it without pulling the
 * AI SDKs into the browser bundle. `index.ts` re-exports these and adds the
 * server-only `getModel()` factory.
 */

// Type-only (erased at build) — keeps this file free of the SDK-heavy index.ts at
// runtime while sharing the one ApiStyle definition.
import type { ApiStyle } from "./index";

// Gateways (LiteLLM proxy, OpenRouter) are listed first: routing every backend
// through one OpenAI-compatible endpoint is the recommended, most scalable
// setup — one adapter, one model list, unified cost/limits. Then the two big
// direct providers, then a cluster of first-party presets that are all just
// OpenAI-compatible endpoints with a baked-in base URL (DeepSeek, Mistral, xAI,
// Z.ai) — no SDK of their own, they ride the same litellm code path. Ollama
// (local) is last.
export const PROVIDERS = [
  "litellm",
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "mistral",
  "xai",
  "zhipu",
  "ollama",
] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/**
 * Native (inline) input modalities. A file whose MIME maps to one of these can
 * be pushed into the message `content` as a `{type:"file"}` part the model API
 * accepts directly; anything else stays in /workspace for the agent to open
 * with sandbox tools. `pdf` covers `application/pdf`; the rest map from the
 * MIME prefix (image/ , audio/ , video/). See `mimeToModality`.
 */
export type Modality = "image" | "pdf" | "audio" | "video";

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
  /** Base URL is OPTIONAL — first-party by default, but the user may point it at
   *  a compatible endpoint that speaks this provider's native wire format (e.g. an
   *  Anthropic-compatible aggregator at /v1/messages). The form shows the field;
   *  an empty value keeps the provider's own default endpoint. */
  optionalBaseUrl?: boolean;
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
   * Native input modalities this provider's AI-SDK adapter can actually
   * serialize — verified against each provider package, NOT just what the
   * upstream API claims. Used as the fallback when per-model modalities are
   * unknown (direct providers, custom endpoints). For OpenRouter the catalog
   * carries per-model `input_modalities`, which override this (see
   * `acceptsNativeFile`).
   *
   * Reality of the SDKs as shipped:
   * - `@ai-sdk/google` emits image/pdf/audio/video → Gemini does all four.
   * - `@openrouter/ai-sdk-provider` emits image_url/input_audio/file but has
   *   NO `video_url`, so video is impossible through it (gated to Google).
   * - `@ai-sdk/openai` emits image/pdf/audio (audio only on audio models).
   * - `@ai-sdk/anthropic` emits image/pdf (no audio, no video).
   * - `@ai-sdk/openai-compatible` emits image_url/input_audio/file; PDF
   *   support depends on the unknown backend, so presets stay conservative.
   */
  nativeInput: Modality[];
}

export const PROVIDER_META: Record<ProviderName, ProviderMeta> = {
  litellm: {
    label: "OpenAI-compatible",
    blurb: "Any OpenAI-style /v1 endpoint — LiteLLM, vLLM, a custom OpenAI endpoint, or your own gateway in front of any provider.",
    recommended: true,
    iconSlug: "litellm",
    requiresKey: true,
    requiresBaseUrl: true,
    baseUrlPlaceholder: "https://your-litellm-host/v1",
    hasCatalog: false,
    // Generic OpenAI-compatible endpoint — backend unknown. Only images are
    // near-universal (image_url); PDF/audio depend on the backend and there's no
    // audio-unsupported retry, so don't speculatively send them.
    nativeInput: ["image"],
  },
  openrouter: {
    label: "OpenRouter",
    blurb: "Hosted gateway to hundreds of models with one key.",
    iconSlug: "openrouter",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: true,
    // Fallback only — per-model `input_modalities` from the catalog decide once
    // synced. PDF is safe (OpenRouter parses it for any model); audio is NOT
    // (model-specific, no retry) so it's left to per-model data. Never video
    // (the SDK provider has no video_url).
    nativeInput: ["image", "pdf"],
  },
  openai: {
    label: "OpenAI",
    // First-party only. A custom OpenAI-compatible endpoint (gateway, proxy,
    // vLLM, …) belongs under the "OpenAI-compatible" provider above, which speaks
    // /chat/completions and works with tools out of the box.
    blurb: "Connect directly to OpenAI (api.openai.com).",
    iconSlug: "openai",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: false,
    // Image + PDF are safe across the chat models. Audio is only on the
    // gpt-4o-audio family, and we can't tell per model here (no audio retry), so
    // it stays tool-only rather than risking a hard error on a non-audio model.
    nativeInput: ["image", "pdf"],
  },
  anthropic: {
    label: "Anthropic",
    blurb: "Connect directly to Claude, or to an Anthropic-compatible endpoint (/v1/messages).",
    iconSlug: "anthropic",
    requiresKey: true,
    requiresBaseUrl: false,
    // Defaults to api.anthropic.com. May point at a compatible gateway that
    // speaks the native Messages API — some aggregators forward `tools` over
    // /v1/messages even when their OpenAI-compat surface drops them.
    optionalBaseUrl: true,
    baseUrlPlaceholder: "https://api.anthropic.com/v1",
    hasCatalog: false,
    // Claude takes images + PDF natively; no audio or video input.
    nativeInput: ["image", "pdf"],
  },
  google: {
    label: "Google Gemini",
    blurb: "Connect directly to Gemini — the only provider with native video and audio.",
    iconSlug: "google",
    requiresKey: true,
    requiresBaseUrl: false,
    hasCatalog: false,
    // Gemini is the multimodal flagship: image, PDF, audio AND video all ride
    // the @ai-sdk/google file part (video can even be a YouTube URL).
    nativeInput: ["image", "pdf", "audio", "video"],
  },
  deepseek: {
    label: "DeepSeek",
    blurb: "Connect directly to DeepSeek — low-cost chat and reasoning models.",
    iconSlug: "deepseek",
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: "https://api.deepseek.com/v1",
    hasCatalog: false,
    // OpenAI-compatible preset: images serialize; its text/vision models don't
    // take PDF/audio/video, so stay conservative and let those fall to tools.
    nativeInput: ["image"],
  },
  mistral: {
    label: "Mistral",
    blurb: "Connect directly to Mistral — open-weight and frontier models from the EU.",
    iconSlug: "mistral",
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: "https://api.mistral.ai/v1",
    hasCatalog: false,
    nativeInput: ["image"],
  },
  xai: {
    label: "xAI (Grok)",
    blurb: "Connect directly to xAI's Grok models.",
    iconSlug: "xai",
    requiresKey: true,
    requiresBaseUrl: false,
    defaultBaseUrl: "https://api.x.ai/v1",
    hasCatalog: false,
    nativeInput: ["image"],
  },
  zhipu: {
    label: "Z.AI (GLM)",
    blurb: "Connect directly to Z.AI — the GLM model family.",
    iconSlug: "zhipu",
    requiresKey: true,
    requiresBaseUrl: false,
    // Z.ai's OpenAI-compatible surface lives under /api/paas/v4 (not /v1).
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    hasCatalog: false,
    nativeInput: ["image"],
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
    // Local vision models take images; nothing else over the Ollama API.
    nativeInput: ["image"],
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

/** The native input modality a file's MIME maps to, or null if it has none
 *  (a generic doc, archive, …) — those always stay tool-only. */
export function mimeToModality(mimeType: string): Modality | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

/**
 * Whether this file can be pushed into the message `content` as a native inline
 * part the model API accepts. Anything that returns `false` is left in
 * /workspace for the agent to open with sandbox tools (tool-only).
 *
 * Precedence:
 * 1. Video only serializes through the Google SDK — gated to Gemini regardless
 *    of any catalog claim (OpenRouter's provider has no `video_url`).
 * 2. OpenRouter parses PDFs server-side for ANY model (its file parser is
 *    model-agnostic), so PDF is always native there — never gated by per-model
 *    `input_modalities`, which often omit `file` even for PDF-capable models.
 * 3. Per-model `modelInput` (OpenRouter's `input_modalities`, when known) is
 *    authoritative — it knows exactly what THIS model takes.
 * 4. Otherwise fall back to the provider's static `nativeInput`.
 * 5. An unknown provider falls to the safe side: only the universal image block.
 */
export function acceptsNativeFile(
  mimeType: string,
  provider: string,
  modelInput?: Modality[] | null,
): boolean {
  const mod = mimeToModality(mimeType);
  if (!mod) return false;
  if (mod === "video") return provider === "google";
  if (mod === "pdf" && provider === "openrouter") return true;
  if (modelInput && modelInput.length) return modelInput.includes(mod);
  if (isProviderName(provider)) return PROVIDER_META[provider].nativeInput.includes(mod);
  return mod === "image";
}

/**
 * Whether this provider+transport correctly serializes an IMAGE returned INSIDE a
 * tool result (the LanguageModelV3 `{type:'content'}` output with `image-data`
 * parts — how `view_file` shows rendered pages to the model). This is a stricter
 * question than `acceptsNativeFile`: it's about tool-result content, not user
 * message content.
 *
 * `@ai-sdk/openai`'s Chat Completions path and `@ai-sdk/openai-compatible`
 * (litellm/deepseek/mistral/xai/zhipu/ollama) `JSON.stringify` the content value,
 * so a base64 image would be injected into the prompt as megabytes of TEXT —
 * excluded. anthropic/google/openrouter and OpenAI's *Responses* transport
 * convert it to a real image block. `apiStyle` here must be the EFFECTIVE style
 * (see resolveUserModelInfo), not the raw "auto".
 */
export function supportsImageToolResults(provider: string, apiStyle?: ApiStyle): boolean {
  if (provider === "anthropic" || provider === "google" || provider === "openrouter") return true;
  if (provider === "openai") return apiStyle === "responses";
  return false;
}

/**
 * Stricter than `acceptsNativeFile` for images, used to gate the `view_file` tool.
 * A USER attachment can be optimistic (the runner soft-retries without it if the
 * model rejects it), but a `view_file` image has NO such retry — an over-claimed
 * capability there fails the whole turn. So offer it only on POSITIVE evidence:
 * a provider that genuinely takes images, or per-model catalog data that says so.
 * A catalog-less openai-compatible endpoint (whose static fallback claims "image"
 * but might front a text-only model) gets the tool ABSENT — graceful, not a crash.
 */
export function modelTakesImages(provider: string, modelInput?: Modality[] | null): boolean {
  if (modelInput && modelInput.length) return modelInput.includes("image");
  return provider === "anthropic" || provider === "google" || provider === "openai" || provider === "openrouter";
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
