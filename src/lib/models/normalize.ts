/**
 * Pure normalization helpers shared by every catalog source. Kept free of I/O
 * so model naming, grouping and icon mapping are trivially testable and
 * consistent no matter which provider a model came from.
 */

export interface Capabilities {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
}

// Map a company/group name to a brand-icon slug the UI can render. Keyword
// matching keeps it resilient to small naming differences across sources.
const ICON_RULES: [RegExp, string][] = [
  [/anthropic|claude/i, "anthropic"],
  [/openai|gpt|o\d|davinci/i, "openai"],
  [/google|gemini|palm|gemma/i, "google"],
  [/\bmeta\b|\bllama/i, "meta"], // \bllama avoids matching "ollama"
  [/mistral|mixtral|codestral|magistral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/x-?ai|grok/i, "xai"],
  [/qwen|alibaba|tongyi/i, "qwen"],
  [/cohere|command/i, "cohere"],
  [/perplexity|sonar/i, "perplexity"],
  [/microsoft|phi\b/i, "microsoft"],
  [/amazon|nova|titan/i, "amazon"],
  [/nvidia|nemotron/i, "nvidia"],
  [/ai21|jamba/i, "ai21"],
  [/minimax/i, "minimax"],
  [/xiaomi|mimo/i, "xiaomi"],
  [/zhipu|z\.?ai|glm/i, "zhipu"],
  [/moonshot|kimi/i, "moonshot"],
  [/ollama/i, "ollama"],
  [/openrouter/i, "openrouter"],
];

export function iconForGroup(group: string | null | undefined): string {
  if (!group) return "generic";
  for (const [re, slug] of ICON_RULES) if (re.test(group)) return slug;
  return "generic";
}

/**
 * Resolve a model's icon: prefer the brand (Anthropic, OpenAI…); when the
 * brand is unknown, fall back to the icon of the integration the model is
 * served through (OpenRouter, Ollama, a custom provider) so nothing renders
 * blank. `fallback` is the integration/provider slug or name.
 */
export function iconForModel(
  group: string | null | undefined,
  fallback: string | null | undefined,
): string {
  const brand = iconForGroup(group);
  if (brand !== "generic") return brand;
  if (!fallback) return "generic";
  const viaName = iconForGroup(fallback);
  if (viaName !== "generic") return viaName;
  // Use the integration slug itself (e.g. "openrouter") as the icon key.
  return fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "generic";
}

// LiteLLM provider slug → human company name.
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  azure: "OpenAI",
  gemini: "Google",
  vertex_ai: "Google",
  "vertex_ai-language-models": "Google",
  google: "Google",
  meta: "Meta",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
  cohere: "Cohere",
  perplexity: "Perplexity",
  ollama: "Ollama",
  bedrock: "Amazon",
  groq: "Groq",
};

export function groupForProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return PROVIDER_NAMES[provider] ?? titleCase(provider.replace(/[-_]/g, " "));
}

// "Anthropic: Claude Opus 4.1" → group "Anthropic". Falls back to the id's
// provider prefix ("anthropic/…").
export function groupFromName(name: string | undefined, id: string): string | null {
  if (name && name.includes(": ")) return name.slice(0, name.indexOf(": "));
  if (id.includes("/")) return groupForProvider(id.slice(0, id.indexOf("/")));
  return null;
}

const DATE_SUFFIX = /[-@:](20\d{2}-\d{2}-\d{2}|20\d{6}|20\d{2}|\d{4}|latest|preview)$/i;

/**
 * Turn a raw model id into a human label when no nice name is supplied.
 * "claude-3-5-haiku-20241022" → "Claude 3 5 Haiku".
 */
export function prettyName(id: string, rawName?: string | null): string {
  if (rawName && rawName.trim() && rawName !== id) return rawName.trim();
  let slug = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  slug = slug.replace(DATE_SUFFIX, "");
  return titleCase(slug.replace(/[-_.]+/g, " ").trim());
}

export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function isDatedSlug(id: string): boolean {
  const slug = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return DATE_SUFFIX.test(slug);
}
