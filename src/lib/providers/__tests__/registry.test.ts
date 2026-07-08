import { describe, it, expect } from "vitest";
import { supportsImageToolResults } from "../registry";

// Guards the transport matrix for images returned INSIDE a tool result (view_file).
// The @ai-sdk/openai chat path and @ai-sdk/openai-compatible JSON.stringify such
// content — a base64 image would land in the prompt as text — so they must be OUT.
describe("supportsImageToolResults", () => {
  it("allows the providers whose adapters convert image-data to a real image block", () => {
    expect(supportsImageToolResults("anthropic")).toBe(true);
    expect(supportsImageToolResults("google")).toBe(true);
    expect(supportsImageToolResults("openrouter")).toBe(true);
  });

  it("allows OpenAI only over the Responses transport, not Chat Completions", () => {
    expect(supportsImageToolResults("openai", "responses")).toBe(true);
    expect(supportsImageToolResults("openai", "chat")).toBe(false);
    // effective style is always resolved before this call — "auto" never reaches it,
    // but guard the default anyway
    expect(supportsImageToolResults("openai")).toBe(false);
  });

  it("excludes every openai-compatible gateway (base64 image would enter as text)", () => {
    for (const p of ["litellm", "deepseek", "mistral", "xai", "zhipu", "ollama"]) {
      expect(supportsImageToolResults(p)).toBe(false);
    }
  });
});
