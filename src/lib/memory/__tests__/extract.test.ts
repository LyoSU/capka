import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import { extractMemories } from "@/lib/memory/extract";

// The model is never used directly (the `ai` call is mocked), so a stub is fine.
const model = {} as never;

beforeEach(() => generateTextMock.mockReset());

describe("extractMemories", () => {
  it("feeds the USER message into the prompt as the primary signal", async () => {
    generateTextMock.mockResolvedValue({ text: "Works at Acme Corp" });
    await extractMemories(
      model,
      { userText: "Hi, I work at Acme Corp on energy stuff", assistantText: "Here is a Python script." },
      [],
    );
    const call = generateTextMock.mock.calls[0][0];
    expect(call.prompt).toContain("User message:");
    expect(call.prompt).toContain("I work at Acme Corp");
    // The assistant reply is included only as labelled context, never as the lead.
    expect(call.prompt.indexOf("User message:")).toBeLessThan(call.prompt.indexOf("Assistant reply"));
  });

  it("short-circuits without calling the model when the user message is trivially short", async () => {
    const out = await extractMemories(model, { userText: "ok" }, []);
    expect(out).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("deduplicates extracted facts against existing memories", async () => {
    generateTextMock.mockResolvedValue({
      text: "Works at Acme Corp\nPrefers dark mode",
    });
    const out = await extractMemories(
      model,
      { userText: "Reminder: I work at Acme Corp and I like dark themes" },
      ["works at acme corp"],
    );
    expect(out).toContain("Prefers dark mode");
    expect(out).not.toContain("Works at Acme Corp");
  });

  it("reports this call's spend via onUsage so it isn't billed-blind", async () => {
    generateTextMock.mockResolvedValue({
      text: "Works at Acme Corp",
      usage: { inputTokens: 500, outputTokens: 12, cachedInputTokens: 100 },
    });
    const onUsage = vi.fn();
    await extractMemories(model, { userText: "I work at Acme Corp on energy stuff" }, [], onUsage);
    // Billable input excludes the cached portion (see toTokenUsage).
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 400, outputTokens: 12, cachedInputTokens: 100 });
  });

  it("does not call onUsage when the model is never invoked (short input)", async () => {
    const onUsage = vi.fn();
    await extractMemories(model, { userText: "ok" }, [], onUsage);
    expect(onUsage).not.toHaveBeenCalled();
  });
});
