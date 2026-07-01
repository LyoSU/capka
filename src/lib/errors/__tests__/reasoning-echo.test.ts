import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { isReasoningEchoRejectedError } from "@/lib/errors/friendly";
import { stripReasoningFromMessages } from "@/lib/chat/context/step-control";

describe("stripReasoningFromMessages", () => {
  it("drops reasoning parts from an intermediate tool-loop assistant message while keeping the tool call", () => {
    // This is the shape streamText re-feeds INSIDE its own tool loop: the
    // assistant turn that reasoned and then called a tool. The openai-compatible
    // SDK serializes the `reasoning` part back as `reasoning_content`, which
    // Cerebras 400s — so it must be stripped, but the tool-call part must survive
    // or the following tool result is orphaned.
    const messages: ModelMessage[] = [
      { role: "user", content: "які ліміти на безкоштовний апі" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "We need to search the web for Cerebras limits." },
          { type: "tool-call", toolCallId: "c1", toolName: "firecrawl_search", input: { q: "cerebras" } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "firecrawl_search", output: { type: "text", value: "..." } }] },
    ] as ModelMessage[];

    const out = stripReasoningFromMessages(messages);
    const assistant = out[1];
    expect(Array.isArray(assistant.content)).toBe(true);
    const parts = assistant.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "reasoning")).toBe(false);
    expect(parts.some((p) => p.type === "tool-call")).toBe(true);
  });

  it("passes through messages with no reasoning parts untouched", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ] as ModelMessage[];
    expect(stripReasoningFromMessages(messages)).toEqual(messages);
  });
});

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
