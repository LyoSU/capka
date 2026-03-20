import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";

export const PROVIDER_MODELS: Record<string, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3-mini"],
  anthropic: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022", "claude-3-5-sonnet-20241022"],
  openrouter: ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514", "google/gemini-2.0-flash-001", "meta-llama/llama-3.3-70b-instruct"],
  ollama: ["llama3.3", "gemma3", "qwen3", "deepseek-r1"],
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
