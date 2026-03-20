import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";

export const PROVIDER_MODELS: Record<string, string[]> = {
  openai: ["gpt-5.2", "gpt-5.2-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3", "o4-mini"],
  anthropic: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250506"],
  openrouter: [], // dynamic — user types any model ID
  ollama: [], // dynamic — depends on locally installed models
};

export function getModel(
  provider: string,
  modelId: string,
  config?: { apiKey?: string; baseUrl?: string },
) {
  switch (provider) {
    case "openai": {
      const p = createOpenAI({ apiKey: config?.apiKey, baseURL: config?.baseUrl });
      return p(modelId);
    }
    case "anthropic": {
      const p = createAnthropic({ apiKey: config?.apiKey, baseURL: config?.baseUrl });
      return p(modelId);
    }
    case "openrouter": {
      const p = createOpenRouter({ apiKey: config?.apiKey! });
      return p.chat(modelId);
    }
    case "ollama": {
      const p = createOllama({ baseURL: config?.baseUrl || "http://localhost:11434/api" });
      return p(modelId);
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
