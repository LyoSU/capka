import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import {
  parseMemoryOps,
  applyMemoryOps,
  clampDoc,
  needsConsolidation,
  reconcileMemoryDoc,
  consolidateMemoryDoc,
} from "@/lib/memory/doc";
import { MEMORY_DOC_MAX_CHARS, MEMORY_CONSOLIDATE_EVERY } from "@/lib/constants";

const model = {} as never;
beforeEach(() => generateTextMock.mockReset());

describe("parseMemoryOps", () => {
  it("parses a clean op array", () => {
    expect(parseMemoryOps('[{"op":"add","text":"Likes tea"}]')).toEqual([{ op: "add", text: "Likes tea" }]);
  });

  it("extracts the array from prose / code-fence wrapping", () => {
    const raw = 'Sure! Here are the edits:\n```json\n[{"op":"remove","text":"old"}]\n```';
    expect(parseMemoryOps(raw)).toEqual([{ op: "remove", text: "old" }]);
  });

  it("drops malformed items and returns [] on non-JSON", () => {
    expect(parseMemoryOps('[{"op":"add"},{"op":"replace","old":"a","new":"b"},{"nope":1}]'))
      .toEqual([{ op: "replace", old: "a", new: "b" }]);
    expect(parseMemoryOps("no array here")).toEqual([]);
  });
});

describe("applyMemoryOps", () => {
  it("adds a fact as a bullet", () => {
    expect(applyMemoryOps("", [{ op: "add", text: "Works at Acme" }])).toBe("- Works at Acme");
  });

  it("skips an add already covered by an existing line (either direction)", () => {
    const doc = "- Works at Acme Corp on energy";
    expect(applyMemoryOps(doc, [{ op: "add", text: "works at acme corp" }])).toBe(doc);
  });

  it("removes lines matching a substring", () => {
    const doc = "- Uses Windows\n- Prefers dark mode";
    expect(applyMemoryOps(doc, [{ op: "remove", text: "windows" }])).toBe("- Prefers dark mode");
  });

  it("replaces a matching line, or appends when nothing matches", () => {
    expect(applyMemoryOps("- Prefers dark mode", [{ op: "replace", old: "dark mode", new: "light mode" }]))
      .toBe("- light mode");
    expect(applyMemoryOps("- Likes tea", [{ op: "replace", old: "absent", new: "Likes coffee" }]))
      .toBe("- Likes tea\n- Likes coffee");
  });
});

describe("clampDoc / needsConsolidation", () => {
  it("clamps to the size ceiling by dropping oldest lines", () => {
    const big = Array.from({ length: 200 }, (_, i) => `- fact number ${i} with some padding text`).join("\n");
    const out = clampDoc(big);
    expect(out.length).toBeLessThanOrEqual(MEMORY_DOC_MAX_CHARS);
    // Newest lines survive, oldest are dropped.
    expect(out).toContain("fact number 199");
    expect(out).not.toContain("fact number 0 ");
  });

  it("triggers consolidation on size or turn count", () => {
    expect(needsConsolidation("x".repeat(MEMORY_DOC_MAX_CHARS + 1), 0)).toBe(true);
    expect(needsConsolidation("small", MEMORY_CONSOLIDATE_EVERY)).toBe(true);
    expect(needsConsolidation("small", 1)).toBe(false);
  });
});

describe("reconcileMemoryDoc", () => {
  it("does not call the model for a trivially short standalone turn", async () => {
    const out = await reconcileMemoryDoc(model, "anthropic", "user", "", { userText: "ok" });
    expect(out).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("parses ops from the model output", async () => {
    generateTextMock.mockResolvedValue({ text: '[{"op":"add","text":"Works at Acme"}]' });
    const out = await reconcileMemoryDoc(model, "anthropic", "user", "", {
      userText: "Just so you know, I work at Acme Corp.",
    });
    expect(out).toEqual([{ op: "add", text: "Works at Acme" }]);
  });

  it("reports spend via onUsage (excluding the cached portion)", async () => {
    generateTextMock.mockResolvedValue({
      text: "[]",
      usage: { inputTokens: 500, outputTokens: 12, cachedInputTokens: 100 },
    });
    const onUsage = vi.fn();
    await reconcileMemoryDoc(model, "anthropic", "user", "", { userText: "I work at Acme on energy stuff" }, onUsage);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 400, outputTokens: 12, cachedInputTokens: 100 });
  });

  it("retries without the reasoning knob when a non-reasoning model rejects it", async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error("400 reasoning_effort is not supported by this model"))
      .mockResolvedValueOnce({ text: '[{"op":"add","text":"Likes coffee"}]' });
    const out = await reconcileMemoryDoc(model, "openai", "user", "", { userText: "By the way, I love coffee." });
    expect(out).toEqual([{ op: "add", text: "Likes coffee" }]);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    // The retry drops providerOptions.
    expect(generateTextMock.mock.calls[1][0].providerOptions).toBeUndefined();
  });
});

describe("consolidateMemoryDoc", () => {
  it("keeps the original when the rewrite is truncated (finishReason length)", async () => {
    generateTextMock.mockResolvedValue({ text: "- partial rewr", finishReason: "length" });
    const doc = "- a\n- b\n- c";
    expect(await consolidateMemoryDoc(model, "anthropic", doc)).toBe(doc);
  });

  it("returns the clamped rewrite on a clean finish", async () => {
    generateTextMock.mockResolvedValue({ text: "- merged fact", finishReason: "stop" });
    expect(await consolidateMemoryDoc(model, "anthropic", "- a\n- b")).toBe("- merged fact");
  });

  it("no-ops on an empty doc without calling the model", async () => {
    expect(await consolidateMemoryDoc(model, "anthropic", "   ")).toBe("   ");
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
