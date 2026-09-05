import { describe, it, expect } from "vitest";
import { isAuxiliaryModel, prettyName } from "@/lib/models/normalize";

describe("prettyName", () => {
  it("keeps well-known acronyms in caps instead of Title-casing them", () => {
    expect(prettyName("gpt-4-0613")).toBe("GPT 4");
    expect(prettyName("gpt-3.5-turbo-16k")).toBe("GPT 3.5 Turbo 16k");
    expect(prettyName("tts-1-hd")).toBe("TTS 1 HD");
    expect(prettyName("glm-5.2")).toBe("GLM 5.2");
    expect(prettyName("chatgpt-4o-latest")).toBe("ChatGPT 4o");
  });

  it("re-joins a version that the id spells with dashes", () => {
    expect(prettyName("claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(prettyName("claude-3-5-haiku-20241022")).toBe("Claude 3.5 Haiku");
    expect(prettyName("qwen-2-5-72b-instruct")).toBe("Qwen 2.5 72b Instruct");
    expect(prettyName("phi-3-5-mini")).toBe("Phi 3.5 Mini");
    // Three parts too, but a long trailing number is a build, not a version.
    expect(prettyName("yi-1-5-9b")).toBe("Yi 1.5 9b");
    expect(prettyName("grok-2-1212")).toBe("Grok 2");
    expect(prettyName("gemma-3-27b")).toBe("Gemma 3 27b");
  });

  it("leaves ordinary words alone", () => {
    expect(prettyName("claude-sonnet-4-20250514")).toBe("Claude Sonnet 4");
    expect(prettyName("deepseek-chat")).toBe("Deepseek Chat");
  });

  it("drops a trailing wildcard marker some aggregators bake into names", () => {
    expect(prettyName("x", "Gemini 2.5 Flash Thinking *")).toBe("Gemini 2.5 Flash Thinking");
    expect(prettyName("x", "Gemini 2.5 Pro Thinking**")).toBe("Gemini 2.5 Pro Thinking");
  });
});

describe("isAuxiliaryModel", () => {
  it.each([
    "tts-1",
    "gpt-4o-mini-tts",
    "whisper-1",
    "gpt-4o-transcribe",
    "text-embedding-3-small",
    "gemini-embedding-001",
    "dall-e-3",
    "gpt-image-1",
    "gemini-2.5-flash-image",
    "imagen-4.0-generate-001",
    "veo-3.0-generate-001",
    "sora-2",
    "davinci-002",
    "babbage-002",
    "omni-moderation-latest",
    "gpt-4o-realtime-preview",
    "audio1.0",
    "openai/gpt-4o-audio-preview",
    "gemini-2.5-flash-preview-tts",
    "cohere/rerank-v3.5",
    "meta-llama/llama-guard-4-12b",
  ])("treats %s as auxiliary (not a chat model)", (id) => {
    expect(isAuxiliaryModel(id)).toBe(true);
  });

  it.each([
    "gpt-4o",
    "gpt-4.1-mini",
    "o3-mini",
    "claude-sonnet-4",
    "gemini-2.5-pro",
    "deepseek-chat",
    "qwen/qwen3-vl-235b",
    "perplexity/sonar-deep-research",
    "meta-llama/llama-3.3-70b-instruct",
    "mistralai/mistral-large",
  ])("keeps %s as a chat model", (id) => {
    expect(isAuxiliaryModel(id)).toBe(false);
  });
});
