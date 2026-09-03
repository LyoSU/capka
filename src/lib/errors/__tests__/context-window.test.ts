import { describe, it, expect } from "vitest";
import { parseContextWindow, isContextOverflowError } from "@/lib/errors/friendly";

// Real overflow texts. None of these providers puts the window in a structured
// field — it exists only in the prose, so the number has to be read out of it.
describe("parseContextWindow", () => {
  it("reads Anthropic's 'N tokens > M maximum'", () => {
    expect(parseContextWindow(new Error("prompt is too long: 213456 tokens > 200000 maximum"))).toBe(200_000);
  });

  it("reads OpenAI's chat-completions phrasing, not the requested size", () => {
    const err = new Error(
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130250 tokens (129000 in the messages, 1250 in the functions). Please reduce the length of the messages or functions.",
    );
    expect(parseContextWindow(err)).toBe(128_000);
  });

  it("reads OpenRouter's endpoint phrasing", () => {
    const err = new Error(
      'This endpoint\'s maximum context length is 131072 tokens. However, you requested about 140000 tokens (139000 of text input, 1000 in the output). Please reduce the length of either one, or use the "middle-out" transform to compress your prompt automatically.',
    );
    expect(parseContextWindow(err)).toBe(131_072);
  });

  it("reads Google's 'maximum number of tokens allowed (N)' — and classifies it as an overflow at all", () => {
    // Names neither "context" nor "length", so the classifier's older shapes
    // missed it and a Gemini overflow never reached the emergency trim.
    const err = new Error("The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).");
    expect(isContextOverflowError(err)).toBe(true);
    expect(parseContextWindow(err)).toBe(1_048_576);
  });

  it("reads Mistral's 'model with N maximum context length'", () => {
    const err = new Error("Prompt contains 40000 tokens too large for model with 32768 maximum context length");
    expect(parseContextWindow(err)).toBe(32_768);
  });

  it("accepts thousands separators", () => {
    expect(parseContextWindow(new Error("This model's maximum context length is 1,048,576 tokens."))).toBe(1_048_576);
  });

  it("returns null when the overflow text carries no number", () => {
    expect(parseContextWindow(new Error("Your input exceeds the context window of this model. Please adjust your input and try again."))).toBeNull();
    expect(parseContextWindow(new Error("Input is too long for requested model."))).toBeNull();
  });

  it("returns null for a non-overflow error that happens to name a token figure", () => {
    // A rate limit is not a window; learning 200k from it would be wrong.
    expect(parseContextWindow(new Error("Rate limit reached: limit 200000 tokens per minute"))).toBeNull();
  });

  it("rejects an implausible figure", () => {
    expect(parseContextWindow(new Error("prompt is too long: 10 tokens > 0 maximum"))).toBeNull();
  });
});
