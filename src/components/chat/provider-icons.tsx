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
import Ollama from "@lobehub/icons/es/Ollama";
import OpenRouter from "@lobehub/icons/es/OpenRouter";

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
  ollama: Ollama,
  openrouter: OpenRouter,
};

export function iconForSlug(slug?: string | null): IconComponent {
  return (slug && ICONS[slug]) || Sparkles;
}
