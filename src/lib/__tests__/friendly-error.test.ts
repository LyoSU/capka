import { describe, it, expect } from "vitest";
import {
  classifyLLMError,
  isVisionUnsupportedError,
  PROVIDER_UNRESPONSIVE_ERROR,
  RESPONSE_TRUNCATED_ERROR,
  LLM_ERROR_CATEGORIES,
} from "@/lib/errors/friendly";
import en from "../../../messages/en.json";
import uk from "../../../messages/uk.json";

describe("content-safety refusals", () => {
  it("maps a provider content-filter refusal to a calm message, not the raw string", () => {
    const r = classifyLLMError("400 Content Exists Risk");
    expect(r.category).toBe("content_blocked");
    expect(r.userMessage).toMatch(/rephras|different model/i);
    expect(r.userMessage).not.toMatch(/Content Exists Risk|400/); // no provider jargon
    expect(r.adminDetail).toContain("Content Exists Risk"); // admins still get it
  });

  it("recognizes the other providers' phrasings", () => {
    for (const raw of [
      "The response was filtered due to the prompt triggering Azure OpenAI's content management policy",
      "ResponsibleAIPolicyViolation",
      "finish_reason: content_filter",
      "Your request was rejected as a result of our safety system",
      "blocked: PROHIBITED_CONTENT",
      "该内容存在违规风险",
    ]) {
      expect(classifyLLMError(raw).category, raw).toBe("content_blocked");
    }
  });

  it("does not steal errors that belong to an actionable category", () => {
    // A quota or auth failure is the admin's to fix and must not be softened into
    // "rephrase your prompt", even when the provider mentions its policy engine.
    expect(classifyLLMError("402 insufficient credits (content policy engine)").category).toBe("out_of_credits");
    expect(classifyLLMError("429 too many requests from the moderation endpoint").category).toBe("rate_limited");
  });
});

describe("errors.llm translations", () => {
  // The chat bubble and the Telegram sink both render a failure through
  // `errors.llm.<category>`; a category shipped without a string renders as a
  // raw key or silently falls back to the English baked into the row.
  it.each([
    ["en", en],
    ["uk", uk],
  ])("covers every LLM error category in %s", (_locale, catalog) => {
    const llm = (catalog as { errors: { llm: Record<string, string> } }).errors.llm;
    for (const category of LLM_ERROR_CATEGORIES) {
      expect(llm[category], category).toBeTruthy();
    }
  });
});

describe("PROVIDER_UNRESPONSIVE_ERROR", () => {
  it("is a distinct category with a calm, model-switch-pointing message and no jargon", () => {
    expect(PROVIDER_UNRESPONSIVE_ERROR.category).toBe("provider_unresponsive");
    expect(PROVIDER_UNRESPONSIVE_ERROR.userMessage).toMatch(/respond|model|try/i);
    expect(PROVIDER_UNRESPONSIVE_ERROR.userMessage).not.toMatch(/stall|idle|abort|signal/i);
    expect(PROVIDER_UNRESPONSIVE_ERROR.adminDetail.length).toBeGreaterThan(0);
  });
});

describe("RESPONSE_TRUNCATED_ERROR", () => {
  it("tells the user to continue, not to retry, and names the lever for admins", () => {
    // Continue, because the reply above stands: regenerating would throw away work
    // the turn already did (and re-run its tools), which is the same reason the
    // partial-stall message exists next to it.
    expect(RESPONSE_TRUNCATED_ERROR.category).toBe("response_truncated");
    expect(RESPONSE_TRUNCATED_ERROR.userMessage).toMatch(/continue/i);
    expect(RESPONSE_TRUNCATED_ERROR.userMessage).not.toMatch(/try again|regenerate/i);
    // No jargon in the user's half — "finishReason", "max_tokens" and friends belong
    // in the admin detail, which is where the fix actually is.
    expect(RESPONSE_TRUNCATED_ERROR.userMessage).not.toMatch(/token|finishReason|max_tokens/i);
    expect(RESPONSE_TRUNCATED_ERROR.adminDetail).toMatch(/max_tokens|output tokens/i);
  });
});

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
