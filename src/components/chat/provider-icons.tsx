import type { ComponentType } from "react";
import { Sparkles } from "lucide-react";
import OpenAI from "@lobehub/icons/es/OpenAI";
import Anthropic from "@lobehub/icons/es/Anthropic";
import Gemini from "@lobehub/icons/es/Gemini";
import Meta from "@lobehub/icons/es/Meta";
import Mistral from "@lobehub/icons/es/Mistral";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Grok from "@lobehub/icons/es/Grok";
import Qwen from "@lobehub/icons/es/Qwen";
import Minimax from "@lobehub/icons/es/Minimax";
import XiaomiMiMo from "@lobehub/icons/es/XiaomiMiMo";
import Nvidia from "@lobehub/icons/es/Nvidia";
import Cohere from "@lobehub/icons/es/Cohere";
import Perplexity from "@lobehub/icons/es/Perplexity";
import Microsoft from "@lobehub/icons/es/Microsoft";
import Bedrock from "@lobehub/icons/es/Bedrock";
import Ai21 from "@lobehub/icons/es/Ai21";
import Zhipu from "@lobehub/icons/es/Zhipu";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Hunyuan from "@lobehub/icons/es/Hunyuan";
import Doubao from "@lobehub/icons/es/Doubao";
import Baidu from "@lobehub/icons/es/Baidu";
import Dbrx from "@lobehub/icons/es/Dbrx";
import InternLM from "@lobehub/icons/es/InternLM";
import Baichuan from "@lobehub/icons/es/Baichuan";
import Stepfun from "@lobehub/icons/es/Stepfun";
import LongCat from "@lobehub/icons/es/LongCat";
import Yi from "@lobehub/icons/es/Yi";
import Ollama from "@lobehub/icons/es/Ollama";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Groq from "@lobehub/icons/es/Groq";
import Cerebras from "@lobehub/icons/es/Cerebras";
import Together from "@lobehub/icons/es/Together";
import Fireworks from "@lobehub/icons/es/Fireworks";
import SambaNova from "@lobehub/icons/es/SambaNova";
import DeepInfra from "@lobehub/icons/es/DeepInfra";
import Novita from "@lobehub/icons/es/Novita";
import Hyperbolic from "@lobehub/icons/es/Hyperbolic";
import SiliconCloud from "@lobehub/icons/es/SiliconCloud";
import Nebius from "@lobehub/icons/es/Nebius";
import Baseten from "@lobehub/icons/es/Baseten";
import Vllm from "@lobehub/icons/es/Vllm";
import LmStudio from "@lobehub/icons/es/LmStudio";
import Azure from "@lobehub/icons/es/Azure";
import OpenCode from "@lobehub/icons/es/OpenCode";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode";
import OpenHands from "@lobehub/icons/es/OpenHands";
import Cursor from "@lobehub/icons/es/Cursor";

export type IconComponent = ComponentType<{ size?: number; className?: string }>;

// Maps the catalog `icon` slug (from src/lib/models/normalize.ts) to a brand
// icon component. Falls back to a neutral sparkle for unknown integrations.
const ICONS: Record<string, IconComponent> = {
  anthropic: Anthropic,
  openai: OpenAI,
  google: Gemini,
  meta: Meta,
  mistral: Mistral,
  deepseek: DeepSeek,
  xai: Grok,
  qwen: Qwen,
  minimax: Minimax,
  xiaomi: XiaomiMiMo,
  nvidia: Nvidia,
  cohere: Cohere,
  perplexity: Perplexity,
  microsoft: Microsoft,
  amazon: Bedrock,
  ai21: Ai21,
  zhipu: Zhipu,
  moonshot: Moonshot,
  hunyuan: Hunyuan,
  doubao: Doubao,
  baidu: Baidu,
  dbrx: Dbrx,
  internlm: InternLM,
  baichuan: Baichuan,
  stepfun: Stepfun,
  longcat: LongCat,
  yi: Yi,
  ollama: Ollama,
  // Routers/gateways (route to many upstreams — distinct from the inference
  // providers below, which host models on their own hardware).
  openrouter: OpenRouter,
  // Inference providers: OpenAI-compatible /v1 endpoints that serve open-weight
  // models. No ICON_RULES entry (a model's *group* is its creator, e.g. Llama),
  // just a glyph so a custom "OpenAI-compatible" connection can be branded.
  groq: Groq,
  cerebras: Cerebras,
  together: Together,
  fireworks: Fireworks,
  sambanova: SambaNova,
  deepinfra: DeepInfra,
  novita: Novita,
  hyperbolic: Hyperbolic,
  siliconflow: SiliconCloud,
  nebius: Nebius,
  baseten: Baseten,
  vllm: Vllm,
  lmstudio: LmStudio,
  azure: Azure,
  // Agent tools (offered as connection glyphs only, never model-creator icons).
  opencode: OpenCode,
  claudecode: ClaudeCode,
  openhands: OpenHands,
  cursor: Cursor,
};

export function iconForSlug(slug?: string | null): IconComponent {
  return (slug && ICONS[slug]) || Sparkles;
}

/** Brand glyphs offered when naming a custom connection. Display labels are
 *  best-effort title-cased slugs; the picker shows the glyph, which is what
 *  actually matters. The empty option means "use the provider's default". */
export const BRAND_ICON_SLUGS = Object.keys(ICONS);
