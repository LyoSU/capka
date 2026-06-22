import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";

// Provider metadata + model-id helpers live in the dependency-free registry so
// client bundles don't pull these AI SDKs. Re-exported here for back-compat.
export * from "./registry";

/**
 * Wrap a model so reasoning it emits *inline* as `<think>…</think>` in the
 * regular text is pulled out into proper `reasoning` parts (the SDK then streams
 * them as `reasoning-delta`, which the runner already renders into the thinking
 * block). WITHOUT this, open-weights reasoning models (DeepSeek-R1, Qwen QwQ, …)
 * served over a raw OpenAI-compatible endpoint or Ollama — which don't split
 * thinking into a separate `reasoning_content` field — leak the literal `<think>`
 * tags straight into the user's answer.
 *
 * The middleware is chunk-aware: it buffers across token boundaries, so a tag
 * split as `<thi` + `nk>` is still caught — something a naive regex over stream
 * deltas (cf. sanitizeTitle, which only runs on already-complete text) cannot do.
 *
 * Safe to apply unconditionally: a provider that already separates reasoning
 * (Anthropic, OpenRouter, the Responses API) puts no `<think>` in the text, so
 * the middleware finds nothing to extract and passes the text through untouched.
 */
// Derived from wrapLanguageModel so we don't import the spec-package model type
// directly (it's only a transitive dep). It's whatever language model the AI SDK
// can wrap — i.e. the same thing every getModel branch returns.
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

export function withReasoningExtraction(model: WrappableModel): WrappableModel {
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

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
      // A gateway that splits reasoning into `reasoning_content` is handled by the
      // provider above; one that doesn't inlines `<think>` in the text — extract it.
      return withReasoningExtraction(p(modelId));
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
      // Local open-weights reasoning models (DeepSeek-R1, Qwen QwQ, …) emit their
      // chain of thought inline as `<think>…</think>` — pull it into reasoning.
      return withReasoningExtraction(p(modelId));
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
