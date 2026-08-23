import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAuxRequest, auxGenerate } from "@/lib/chat/context/aux";
import type { LanguageModel, ModelMessage } from "ai";

const generateText = vi.hoisted(() => vi.fn());
const memo = vi.hoisted(() => ({ get: vi.fn(), remember: vi.fn() }));

vi.mock("ai", () => ({ generateText }));
vi.mock("@/lib/models/catalog", () => ({
  getModelCannotReason: memo.get,
  rememberModelCannotReason: memo.remember,
}));
vi.mock("@/lib/telemetry", () => ({
  telemetryFor: () => undefined,
  withoutParentContext: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

describe("buildAuxRequest", () => {
  const system: ModelMessage[] = [{ role: "system", content: "persona" }];
  const history: ModelMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
  ];

  it("reuses the hot system+history prefix and appends the reply + instruction as the tail", () => {
    const out = buildAuxRequest(system, history, "the final answer", "Extract facts.");

    // Cache hit: the warmed prefix is preserved byte-for-byte, in order.
    expect(out.slice(0, system.length + history.length)).toEqual([...system, ...history]);

    // The just-produced assistant reply, then the instruction as the final user turn.
    expect(out[out.length - 2]).toEqual({ role: "assistant", content: "the final answer" });
    expect(out[out.length - 1]).toEqual({ role: "user", content: "Extract facts." });
  });

  it("omits the assistant turn when there is no reply text", () => {
    const out = buildAuxRequest(system, history, "", "Extract facts.");
    expect(out).toHaveLength(system.length + history.length + 1);
    expect(out[out.length - 1]).toEqual({ role: "user", content: "Extract facts." });
  });
});


/**
 * A model that cannot reason used to pay a rejected request on EVERY aux call —
 * a chat title, a memory doc, a summary — because this path retried without the
 * knob and remembered nothing. The runner's path learned; its neighbour here did
 * not, which is the same asymmetry one layer out.
 *
 * Note what is being suppressed: `auxReasoningOptions` sends a reasoning
 * parameter in order to turn reasoning DOWN (`reasoningEffort: "low"`,
 * `thinking: disabled`). A model that rejects the parameter rejects the
 * suppression too, so "ask it to think less" is itself the wasted request.
 */
describe("auxGenerate remembers a model that cannot reason", () => {
  const model = { modelId: "stealth/ox-alpha" } as unknown as LanguageModel;
  const args = { system: "s", prompt: "p", maxOutputTokens: 10 } as const;
  const rejection = new Error(
    "litellm.UnsupportedParamsError: openrouter does not support parameters: ['reasoning_effort'], for model=stealth/ox-alpha",
  );

  beforeEach(() => {
    generateText.mockReset();
    memo.get.mockReset().mockResolvedValue(false);
    memo.remember.mockReset().mockResolvedValue(undefined);
  });

  it("sends no reasoning knob at all once the refusal is remembered", async () => {
    memo.get.mockResolvedValue(true);
    generateText.mockResolvedValue({ text: "ok", usage: {} });

    await auxGenerate(model, "litellm", args);

    expect(generateText).toHaveBeenCalledTimes(1); // no rejected first attempt
    expect(generateText.mock.calls[0][0]).not.toHaveProperty("providerOptions");
  });

  it("persists the refusal and retries without the knob", async () => {
    generateText.mockRejectedValueOnce(rejection).mockResolvedValueOnce({ text: "ok", usage: {} });

    const out = await auxGenerate(model, "litellm", args);

    expect(out.text).toBe("ok");
    expect(memo.remember).toHaveBeenCalledWith("stealth/ox-alpha", "litellm");
    // The retry drops the knob; the first attempt carried it.
    expect(generateText.mock.calls[0][0]).toHaveProperty("providerOptions");
    expect(generateText.mock.calls[1][0]).not.toHaveProperty("providerOptions");
  });

  it("keys the memo on the model's own id, not the provider", async () => {
    // The id rides on the model — `LanguageModel` is a V2/V3 object carrying
    // `modelId`, or the id string itself. Threading a parameter through
    // generateChatTitle, the memory-doc builders and their stores would have been
    // five files of signature churn for something already in hand.
    memo.get.mockResolvedValue(false);
    generateText.mockResolvedValue({ text: "ok", usage: {} });

    await auxGenerate("bare-string-model" as unknown as LanguageModel, "openai", args);

    expect(memo.get).toHaveBeenCalledWith("bare-string-model");
  });

  it("does not remember an unrelated failure", async () => {
    generateText.mockRejectedValue(new Error("429 rate limited"));

    await expect(auxGenerate(model, "litellm", args)).rejects.toThrow(/rate limited/);
    expect(memo.remember).not.toHaveBeenCalled();
  });
});
