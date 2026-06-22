import { describe, it, expect } from "vitest";
import { streamText } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { withReasoningExtraction } from "../index";

// The stream-part type the mock's doStream must yield — derived from the SDK's
// own mock so we don't import the spec package (a transitive dep) by name.
type StreamPart = Awaited<
  ReturnType<MockLanguageModelV3["doStream"]>
>["stream"] extends ReadableStream<infer P>
  ? P
  : never;

/** A mock model whose doStream emits the given text deltas as one text block. */
function mockTextModel(deltas: string[]) {
  const chunks: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "0", delta })),
    { type: "text-end", id: "0" },
    {
      type: "finish",
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

/** Drain a wrapped model's fullStream into the reasoning + text it produced. */
async function collect(model: ReturnType<typeof withReasoningExtraction>) {
  const result = streamText({ model, prompt: "hi" });
  let reasoning = "";
  let text = "";
  for await (const part of result.fullStream) {
    if (part.type === "reasoning-delta") reasoning += part.text;
    if (part.type === "text-delta") text += part.text;
  }
  return { reasoning, text };
}

describe("withReasoningExtraction", () => {
  it("pulls inline <think> tags out of the text into reasoning", async () => {
    const model = withReasoningExtraction(
      mockTextModel(["<think>I should greet them</think>Hello!"]),
    );
    const { reasoning, text } = await collect(model);
    expect(reasoning).toBe("I should greet them");
    expect(text).toBe("Hello!");
    expect(text).not.toContain("<think");
  });

  it("handles a <think> tag split across stream chunks", async () => {
    // The whole point of the middleware over a naive regex: the opening and
    // closing tags arrive token-by-token, never whole in a single delta.
    const model = withReasoningExtraction(
      mockTextModel(["<thi", "nk>step one", " step two</thi", "nk>the answer"]),
    );
    const { reasoning, text } = await collect(model);
    expect(reasoning).toBe("step one step two");
    expect(text).toBe("the answer");
    expect(text).not.toContain("think");
  });

  it("leaves a tag-free response untouched (no false reasoning)", async () => {
    const model = withReasoningExtraction(mockTextModel(["Just a plain answer."]));
    const { reasoning, text } = await collect(model);
    expect(reasoning).toBe("");
    expect(text).toBe("Just a plain answer.");
  });
});
