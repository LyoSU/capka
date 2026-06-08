import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";

// Provider metadata + model-id helpers live in the dependency-free registry so
// client bundles don't pull these AI SDKs. Re-exported here for back-compat.
export * from "./registry";

export function getModel(
  provider: string,
  modelId: string,
  config?: { apiKey?: string; baseUrl?: string },
) {
  switch (provider) {
    case "litellm": {
      // Any OpenAI-compatible gateway (LiteLLM proxy, vLLM, Together, …).
      // Use Chat Completions (.chat), NOT the default Responses API — gateways
      // universally expose /chat/completions, while /responses often 404s.
      const p = createOpenAI({ apiKey: config?.apiKey, baseURL: config?.baseUrl });
      return p.chat(modelId);
    }
    case "openai": {
      const p = createOpenAI({ apiKey: config?.apiKey, baseURL: config?.baseUrl });
      return p(modelId);
    }
    case "anthropic": {
      const p = createAnthropic({ apiKey: config?.apiKey, baseURL: config?.baseUrl });
      return p(modelId);
    }
    case "openrouter": {
      const p = createOpenRouter({ apiKey: config?.apiKey ?? "" });
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
