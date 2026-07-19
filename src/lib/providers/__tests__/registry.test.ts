import { describe, it, expect } from "vitest";
import {
  supportsImageToolResults,
  normalizeAzureBaseUrl,
  parseBedrockEndpoint,
  azureDeploymentSuggestions,
} from "../registry";

// Guards the transport matrix for images returned INSIDE a tool result (view_file).
// The @ai-sdk/openai chat path and @ai-sdk/openai-compatible JSON.stringify such
// content — a base64 image would land in the prompt as text — so they must be OUT.
describe("supportsImageToolResults", () => {
  it("allows the providers whose adapters convert image-data to a real image block", () => {
    expect(supportsImageToolResults("anthropic")).toBe(true);
    expect(supportsImageToolResults("google")).toBe(true);
    expect(supportsImageToolResults("vertex")).toBe(true);
    expect(supportsImageToolResults("bedrock")).toBe(true);
    expect(supportsImageToolResults("openrouter")).toBe(true);
  });

  it("allows OpenAI and Azure only over the Responses transport, not Chat Completions", () => {
    for (const p of ["openai", "azure"]) {
      expect(supportsImageToolResults(p, "responses")).toBe(true);
      expect(supportsImageToolResults(p, "chat")).toBe(false);
      // effective style is always resolved before this call — "auto" never reaches it,
      // but guard the default anyway
      expect(supportsImageToolResults(p)).toBe(false);
    }
  });

  it("excludes every openai-compatible gateway (base64 image would enter as text)", () => {
    for (const p of ["litellm", "deepseek", "mistral", "xai", "groq", "zhipu", "ollama"]) {
      expect(supportsImageToolResults(p)).toBe(false);
    }
  });
});

// The SDK's URL builder treats the two host classes differently: on
// *.openai.azure.com it appends /v1 + ?api-version itself (prefix must stop at
// /openai); any other host is used verbatim (prefix must carry /openai/v1).
describe("normalizeAzureBaseUrl", () => {
  it("ends the prefix at /openai for *.openai.azure.com whatever form was pasted", () => {
    for (const raw of [
      "https://res.openai.azure.com",
      "https://res.openai.azure.com/",
      "https://res.openai.azure.com/openai",
      "https://res.openai.azure.com/openai/v1",
      "https://res.openai.azure.com/openai/v1/",
      "  https://res.openai.azure.com/openai ",
    ]) {
      expect(normalizeAzureBaseUrl(raw)).toBe("https://res.openai.azure.com/openai");
    }
  });

  it("strips the operation path + api-version the portal's Target URI copy button includes", () => {
    // Foundry resource (*.services.ai.azure.com) — verbatim host class.
    for (const raw of [
      "https://res.services.ai.azure.com/openai/v1/responses?api-version=v1",
      "https://res.services.ai.azure.com/openai/v1/chat/completions",
      "https://res.services.ai.azure.com/openai/responses",
      "https://res.services.ai.azure.com/openai/v1",
      "https://res.services.ai.azure.com",
    ]) {
      expect(normalizeAzureBaseUrl(raw)).toBe("https://res.services.ai.azure.com/openai/v1");
    }
    // Classic resource — SDK builds the path itself, prefix always stops at /openai.
    for (const raw of [
      "https://res.openai.azure.com/openai/responses?api-version=2025-04-01-preview",
      "https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-06-01",
      "https://res.openai.azure.com/openai/v1/responses",
    ]) {
      expect(normalizeAzureBaseUrl(raw)).toBe("https://res.openai.azure.com/openai");
    }
  });

  it("carries the full /openai/v1 path for non-Azure hosts (Foundry, APIM, gateways)", () => {
    expect(normalizeAzureBaseUrl("https://res.cognitiveservices.azure.com")).toBe(
      "https://res.cognitiveservices.azure.com/openai/v1",
    );
    expect(normalizeAzureBaseUrl("https://res.cognitiveservices.azure.com/openai")).toBe(
      "https://res.cognitiveservices.azure.com/openai/v1",
    );
    // A gateway that already exposes a full custom prefix is left alone.
    expect(normalizeAzureBaseUrl("https://gw.example.com/azure/openai/v1")).toBe(
      "https://gw.example.com/azure/openai/v1",
    );
  });

  it("returns non-URL garbage unchanged (the connect test will surface the failure)", () => {
    expect(normalizeAzureBaseUrl("not a url")).toBe("not a url");
  });
});

// Azure's /openai/v1/models returns the base-model CATALOG with version-suffixed
// ids ("gpt-5-mini-2025-08-07") — none of which are runnable model ids (Azure
// wants deployment names). When the deployments endpoint is unreachable, the
// listing falls back to these ids reduced to plausible deployment names (the
// portal's default deployment name is the bare model name).
describe("azureDeploymentSuggestions", () => {
  it("strips date/version suffixes and dedupes, preserving order", () => {
    expect(
      azureDeploymentSuggestions([
        "gpt-5-mini-2025-08-07",
        "gpt-5.2-2025-12-11",
        "gpt-5.2-2026-02-10",
        "dall-e-3-3.0",
        "gpt-4.1",
      ]),
    ).toEqual(["gpt-5-mini", "gpt-5.2", "dall-e-3", "gpt-4.1"]);
  });
});

// The Bedrock endpoint field is a bare AWS Region (fixed public host — the
// friendly default) or a full URL (private gateway / VPC endpoint).
describe("parseBedrockEndpoint", () => {
  it("treats a bare region as region-only (no baseURL → no SSRF surface)", () => {
    expect(parseBedrockEndpoint("eu-central-1")).toEqual({ region: "eu-central-1" });
    expect(parseBedrockEndpoint(" us-east-1 ")).toEqual({ region: "us-east-1" });
    expect(parseBedrockEndpoint("")).toEqual({ region: "us-east-1" });
  });

  it("extracts the region from an amazonaws.com runtime URL", () => {
    expect(parseBedrockEndpoint("https://bedrock-runtime.ap-southeast-2.amazonaws.com/")).toEqual({
      region: "ap-southeast-2",
      baseURL: "https://bedrock-runtime.ap-southeast-2.amazonaws.com",
    });
  });

  it("keeps a custom gateway URL and falls back to us-east-1 for the region", () => {
    expect(parseBedrockEndpoint("https://bedrock.internal.example.com")).toEqual({
      region: "us-east-1",
      baseURL: "https://bedrock.internal.example.com",
    });
  });
});
