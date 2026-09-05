import { createElement, type ComponentType } from "react";
import { Sparkles } from "lucide-react";
import { BRAND_ICONS } from "./brand-icons";

export type IconComponent = ComponentType<{ size?: number; className?: string }>;

// One renderer for every brand: the same 24x24 box in currentColor, with the
// geometry read from brand-icons.ts. Built once per brand at module load, so each
// slug keeps a stable component identity — building one during render is what the
// static-components lint forbids, and it would remount every glyph on each keystroke
// in the model picker.
function brandIcon(name: string): IconComponent {
  const { title, paths } = BRAND_ICONS[name];
  const Icon = ({ size = 24, className }: { size?: number; className?: string }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ flex: "none", lineHeight: 1 }}
    >
      <title>{title}</title>
      {paths.map(([d, fillOpacity], i) => (
        <path key={i} d={d} fillOpacity={fillOpacity} />
      ))}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

const BY_NAME: Record<string, IconComponent> = Object.fromEntries(
  Object.keys(BRAND_ICONS).map((name) => [name, brandIcon(name)]),
);

// Maps the catalog `icon` slug (from src/lib/models/normalize.ts) to a brand
// icon component. Falls back to a neutral sparkle for unknown integrations.
const ICONS: Record<string, IconComponent> = {
  anthropic: BY_NAME.Anthropic,
  openai: BY_NAME.OpenAI,
  google: BY_NAME.Gemini,
  meta: BY_NAME.Meta,
  mistral: BY_NAME.Mistral,
  deepseek: BY_NAME.DeepSeek,
  xai: BY_NAME.XAI,
  qwen: BY_NAME.Qwen,
  minimax: BY_NAME.Minimax,
  xiaomi: BY_NAME.XiaomiMiMo,
  nvidia: BY_NAME.Nvidia,
  cohere: BY_NAME.Cohere,
  perplexity: BY_NAME.Perplexity,
  microsoft: BY_NAME.Microsoft,
  amazon: BY_NAME.Bedrock,
  bedrock: BY_NAME.Bedrock,
  vertexai: BY_NAME.VertexAI,
  ai21: BY_NAME.Ai21,
  zhipu: BY_NAME.Zhipu,
  moonshot: BY_NAME.Moonshot,
  hunyuan: BY_NAME.Hunyuan,
  doubao: BY_NAME.Doubao,
  baidu: BY_NAME.Baidu,
  dbrx: BY_NAME.Dbrx,
  internlm: BY_NAME.InternLM,
  baichuan: BY_NAME.Baichuan,
  stepfun: BY_NAME.Stepfun,
  longcat: BY_NAME.LongCat,
  yi: BY_NAME.Yi,
  upstage: BY_NAME.Upstage,
  nousresearch: BY_NAME.NousResearch,
  liquid: BY_NAME.Liquid,
  ollama: BY_NAME.Ollama,
  // Routers/gateways (route to many upstreams — distinct from the inference
  // providers below, which host models on their own hardware).
  openrouter: BY_NAME.OpenRouter,
  // Inference providers: OpenAI-compatible /v1 endpoints that serve open-weight
  // models. No ICON_RULES entry (a model's *group* is its creator, e.g. Llama),
  // just a glyph so a custom "OpenAI-compatible" connection can be branded.
  groq: BY_NAME.Groq,
  cerebras: BY_NAME.Cerebras,
  together: BY_NAME.Together,
  fireworks: BY_NAME.Fireworks,
  sambanova: BY_NAME.SambaNova,
  deepinfra: BY_NAME.DeepInfra,
  novita: BY_NAME.Novita,
  hyperbolic: BY_NAME.Hyperbolic,
  siliconflow: BY_NAME.SiliconCloud,
  nebius: BY_NAME.Nebius,
  baseten: BY_NAME.Baseten,
  vllm: BY_NAME.Vllm,
  lmstudio: BY_NAME.LmStudio,
  azure: BY_NAME.Azure,
  huggingface: BY_NAME.HuggingFace,
  cloudflare: BY_NAME.Cloudflare,
  github: BY_NAME.Github,
  // Agent tools (offered as connection glyphs only, never model-creator icons).
  opencode: BY_NAME.OpenCode,
  claudecode: BY_NAME.ClaudeCode,
  openhands: BY_NAME.OpenHands,
  cursor: BY_NAME.Cursor,
};

export function iconForSlug(slug?: string | null): IconComponent {
  return (slug && ICONS[slug]) || Sparkles;
}

/** Brand glyph — resolves a slug to its (stable) icon component and renders it.
 *  Use this instead of `const Icon = iconForSlug(...)` + `<Icon/>`, which the
 *  static-components lint flags as creating a component during render. */
export function ProviderGlyph({ slug, size, className }: { slug?: string | null; size?: number; className?: string }) {
  return createElement(iconForSlug(slug), { size, className });
}

/** Brand glyphs offered when naming a custom connection. Display labels are
 *  best-effort title-cased slugs; the picker shows the glyph, which is what
 *  actually matters. The empty option means "use the provider's default". */
export const BRAND_ICON_SLUGS = Object.keys(ICONS);
