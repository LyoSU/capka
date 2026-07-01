import { describe, it, expect } from "vitest";
import { isReasoningEchoRejectedError } from "@/lib/errors/friendly";

describe("isReasoningEchoRejectedError", () => {
  it("matches the Cerebras/LiteLLM rejection of reasoning_content echoed back in history", () => {
    expect(
      isReasoningEchoRejectedError(
        "CerebrasException - messages.4.assistant.reasoning_content: property 'messages.4.assistant.reasoning_content' is unsupported. Received Model Group=cerebras/gpt-oss-120b",
      ),
    ).toBe(true);
  });

  it("matches wording variants that reject the field on input", () => {
    expect(isReasoningEchoRejectedError("reasoning_content is not allowed")).toBe(true);
    expect(isReasoningEchoRejectedError("unexpected property: reasoning_content")).toBe(true);
    expect(isReasoningEchoRejectedError(new Error("400 invalid parameter reasoning_content"))).toBe(true);
  });

  it("does NOT match DeepSeek, which REQUIRES reasoning_content passed back (stripping would loop it)", () => {
    expect(
      isReasoningEchoRejectedError(
        "The reasoning_content in the thinking mode must be passed back to the API in all subsequent requests.",
      ),
    ).toBe(false);
  });

  it("does NOT match a bare reasoning-capability rejection (that's isReasoningUnsupportedError's job)", () => {
    expect(isReasoningEchoRejectedError("reasoning_effort is not supported by this model")).toBe(false);
  });

  it("does NOT match unrelated errors", () => {
    expect(isReasoningEchoRejectedError("401 invalid api key")).toBe(false);
    expect(isReasoningEchoRejectedError("messages must alternate")).toBe(false);
  });
});
