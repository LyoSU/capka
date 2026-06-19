import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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
      // Any OpenAI-compatible gateway (LiteLLM proxy, vLLM, OpenCode Zen, …).
      // The dedicated openai-compatible provider (not @ai-sdk/openai) is the
      // right tool here: it speaks /chat/completions AND parses the non-standard
      // `reasoning_content`/`reasoning` fields that gateways use to stream a
      // model's thinking — the official OpenAI provider drops those, so reasoning
      // never reached the UI. `name` is the providerOptions namespace (see runner).
      const p = createOpenAICompatible({
        name: "litellm",
        baseURL: config?.baseUrl ?? "",
        apiKey: config?.apiKey,
      });
      return p(modelId);
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
