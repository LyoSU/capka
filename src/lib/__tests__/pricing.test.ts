import { describe, it, expect } from "vitest";
import { computeCost } from "../pricing";
import {
  iconForGroup,
  iconForModel,
  groupFromName,
  prettyName,
  isDatedSlug,
} from "../models/normalize";
import { parseOpenRouterModels, parseLiteLLMModels } from "../models/catalog";

describe("computeCost", () => {
  it("sums input, output and cached reads at per-token rates", () => {
    const got = computeCost(
      { input: 0.000015, output: 0.000075, cacheRead: 0.0000015 },
      { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 200_000 },
    );
    expect(got).toBeCloseTo(15 + 37.5 + 0.3, 6);
  });
});

describe("normalize", () => {
  it("maps companies to brand icon slugs", () => {
    expect(iconForGroup("Anthropic")).toBe("anthropic");
    expect(iconForGroup("OpenAI")).toBe("openai");
    expect(iconForGroup("Google")).toBe("google");
    expect(iconForGroup("Unknown Co")).toBe("generic");
  });

  it("falls back to the integration icon when the brand is unknown", () => {
    expect(iconForModel("Some Startup", "OpenRouter")).toBe("openrouter");
    expect(iconForModel(null, "ollama")).toBe("ollama");
    expect(iconForModel("Anthropic", "OpenRouter")).toBe("anthropic"); // brand wins
  });

  it("derives a group from a nice name or id prefix", () => {
    expect(groupFromName("Anthropic: Claude Opus 4.1", "anthropic/claude-opus-4.1")).toBe("Anthropic");
    expect(groupFromName(undefined, "openai/gpt-4o")).toBe("OpenAI");
  });

  it("prettifies code ids into human names", () => {
    expect(prettyName("anthropic/claude-3-5-haiku-20241022")).toBe("Claude 3 5 Haiku");
    expect(prettyName("x", "Anthropic: Claude Opus 4.1")).toBe("Anthropic: Claude Opus 4.1");
  });

  it("detects date-stamped slugs", () => {
    expect(isDatedSlug("openai/gpt-4o-2024-08-06")).toBe(true);
    expect(isDatedSlug("anthropic/claude-opus-4.1")).toBe(false);
  });
});

describe("parseOpenRouterModels", () => {
  const RAW = {
    data: [
      {
        id: "anthropic/claude-opus-4.1",
        name: "Anthropic: Claude Opus 4.1",
        context_length: 200000,
        architecture: { input_modalities: ["text", "image", "file"] },
        pricing: { prompt: "0.000015", completion: "0.000075", input_cache_read: "0.0000015" },
        supported_parameters: ["tools", "reasoning"],
      },
      {
        id: "someorg/free-model:free",
        name: "SomeOrg: Free Model",
        context_length: 32000,
        pricing: { prompt: "0", completion: "0" },
      },
    ],
  };

  it("parses pricing, capabilities, group and icon; curates noisy/free variants out", () => {
    const out = parseOpenRouterModels(RAW);
    const opus = out.find((m) => m.id === "anthropic/claude-opus-4.1")!;
    expect(opus.displayName).toBe("Anthropic: Claude Opus 4.1");
    expect(opus.group).toBe("Anthropic");
    expect(opus.icon).toBe("anthropic");
    expect(opus.inputPrice).toBeCloseTo(0.000015, 12);
    expect(opus.capabilities).toEqual({ vision: true, tools: true, reasoning: true });
    expect(opus.enabled).toBe(true);

    const free = out.find((m) => m.id === "someorg/free-model:free")!;
    expect(free.enabled).toBe(false); // :free + zero price → not curated in
  });
});

describe("parseLiteLLMModels", () => {
  const RAW = {
    sample_spec: { mode: "chat", input_cost_per_token: 0 },
    "claude-opus-4-1": {
      litellm_provider: "anthropic",
      mode: "chat",
      input_cost_per_token: 0.000015,
      output_cost_per_token: 0.000075,
      cache_read_input_token_cost: 0.0000015,
      max_input_tokens: 200000,
      supports_vision: true,
      supports_function_calling: true,
    },
    "text-embedding-3-small": {
      litellm_provider: "openai",
      mode: "embedding",
      input_cost_per_token: 0.00000002,
    },
  };

  it("imports chat models only, skips sample_spec and non-chat modes", () => {
    const out = parseLiteLLMModels(RAW);
    expect(out.map((m) => m.id)).toEqual(["claude-opus-4-1"]);
    const m = out[0];
    expect(m.group).toBe("Anthropic");
    expect(m.icon).toBe("anthropic");
    expect(m.outputPrice).toBeCloseTo(0.000075, 12);
    expect(m.capabilities.vision).toBe(true);
    expect(m.enabled).toBe(false); // litellm rows are price coverage, off by default
  });

  it("derives native input modalities from LiteLLM's real fields (array ∪ flags)", () => {
    const raw = {
      // supported_modalities carries audio/video but the per-flag is absent —
      // exactly like gemini-2.5-flash. pdf is never in the array, only the flag.
      "gemini-2.5-flash": {
        litellm_provider: "gemini", mode: "chat", input_cost_per_token: 0.000001,
        supported_modalities: ["text", "image", "audio", "video"],
        supports_vision: true, supports_pdf_input: true,
      },
      // Flags only, no array — like gpt-4o-audio-preview.
      "gpt-4o-audio-preview": {
        litellm_provider: "openai", mode: "chat", input_cost_per_token: 0.000001,
        supports_audio_input: true,
      },
      // Vision + pdf flags only — like gpt-4o / claude.
      "gpt-4o": {
        litellm_provider: "openai", mode: "chat", input_cost_per_token: 0.000001,
        supports_vision: true, supports_pdf_input: true,
      },
      // No modality signals at all → no input (stays text-only / tool-only).
      "text-only": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 0.000001 },
    };
    const out = parseLiteLLMModels(raw);
    const byId = Object.fromEntries(out.map((m) => [m.id, m.capabilities.input]));
    expect(byId["gemini-2.5-flash"]).toEqual(["image", "pdf", "audio", "video"]);
    expect(byId["gpt-4o-audio-preview"]).toEqual(["audio"]);
    expect(byId["gpt-4o"]).toEqual(["image", "pdf"]);
    expect(byId["text-only"]).toBeUndefined();
  });
});
