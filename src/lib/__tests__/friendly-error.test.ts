import { describe, it, expect } from "vitest";
import { classifyLLMError, isVisionUnsupportedError } from "@/lib/errors/friendly";

describe("classifyLLMError", () => {
  it("maps OpenRouter 402 / out-of-credits to a top-up message, keeping raw detail for admins", () => {
    const raw =
      'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 53908.';
    const r = classifyLLMError(raw);
    expect(r.category).toBe("out_of_credits");
    expect(r.userMessage).toMatch(/out of credit|top it up/i);
    expect(r.userMessage).not.toMatch(/max_tokens|65536/); // no jargon for users
    expect(r.adminDetail).toContain("65536"); // admins still get the detail
  });

  it("maps auth failures", () => {
    expect(classifyLLMError("401 Unauthorized: invalid api key").category).toBe("invalid_key");
  });

  it("maps rate limits", () => {
    expect(classifyLLMError("429 rate limit exceeded").category).toBe("rate_limited");
  });

  it("maps context-length errors", () => {
    expect(classifyLLMError("maximum context length is 128000 tokens").category).toBe("context_too_long");
  });

  it("maps network errors", () => {
    expect(classifyLLMError(new Error("fetch failed: ECONNREFUSED")).category).toBe("network");
  });

  it("falls back to a friendly generic message for unknown errors", () => {
    const r = classifyLLMError("some weird internal explosion");
    expect(r.category).toBe("unknown");
    expect(r.userMessage).toMatch(/try again/i);
    expect(r.adminDetail).toBe("some weird internal explosion");
  });
});

describe("isVisionUnsupportedError", () => {
  it("detects the common provider phrasings for image/vision rejection", () => {
    const hits = [
      "This model does not support image input.",
      "Error: vision is not supported by this model",
      "messages: image_url is not a valid content type for this model",
      "The selected model has no vision capability",
      "model does not support multimodal messages",
      "This model can't process images",
    ];
    for (const h of hits) expect(isVisionUnsupportedError(h), h).toBe(true);
    expect(isVisionUnsupportedError(new Error("multimodal input rejected"))).toBe(true);
  });

  it("does NOT fire on unrelated capability/other errors (so attachments aren't stripped wrongly)", () => {
    const misses = [
      "This model does not support tools.",
      "429 rate limit exceeded",
      "context length exceeded",
      "fetch failed: ECONNREFUSED",
      "",
    ];
    for (const m of misses) expect(isVisionUnsupportedError(m), m).toBe(false);
  });
});
