import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import { generateChatTitle, sanitizeTitle } from "@/lib/chat/title";

// The model is never used directly (the `ai` call is mocked), so a stub is fine.
const model = {} as never;

beforeEach(() => generateTextMock.mockReset());

describe("sanitizeTitle", () => {
  it("strips surrounding quotes and trailing punctuation", () => {
    expect(sanitizeTitle('"Deploy script fix."')).toBe("Deploy script fix");
    expect(sanitizeTitle("«Налаштування пошти»")).toBe("Налаштування пошти");
  });

  it("removes a leading bullet/dash the model may add", () => {
    expect(sanitizeTitle("- Refactor the runner")).toBe("Refactor the runner");
  });

  it("collapses internal whitespace and newlines", () => {
    expect(sanitizeTitle("Set   up\nthe  bot")).toBe("Set up the bot");
  });

  it("treats the abstain sentinel and empty output as no title", () => {
    expect(sanitizeTitle("-")).toBeNull();
    expect(sanitizeTitle("   ")).toBeNull();
    expect(sanitizeTitle('"-"')).toBeNull();
  });

  it("clamps overly long titles", () => {
    const long = "word ".repeat(40).trim();
    expect(sanitizeTitle(long)!.length).toBeLessThanOrEqual(80);
  });

  it("strips a closed reasoning block and keeps the real title", () => {
    expect(sanitizeTitle("<think>the user said hi, topic is login</think>Fix login bug")).toBe(
      "Fix login bug",
    );
    expect(sanitizeTitle("<thinking>\nlet me think\n</thinking>\nDeploy script")).toBe(
      "Deploy script",
    );
  });

  it("abstains when the output is an unclosed reasoning tag (token-truncated)", () => {
    // Reasoning models token-truncated mid-thought: no usable title remains.
    expect(sanitizeTitle('<think> The user just said "Привіт')).toBeNull();
    expect(sanitizeTitle("<reasoning>the topic seems to be")).toBeNull();
  });
});

describe("generateChatTitle", () => {
  it("returns a sanitized title from the model", async () => {
    generateTextMock.mockResolvedValue({ text: '  "Fix login bug"  ' });
    expect(await generateChatTitle(model, "openai", "the login button is broken")).toBe("Fix login bug");
  });

  it("skips empty user input without calling the model", async () => {
    expect(await generateChatTitle(model, "openai", " ")).toBeNull();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("returns null (keeps the placeholder) when the model abstains", async () => {
    generateTextMock.mockResolvedValue({ text: "-" });
    expect(await generateChatTitle(model, "openai", "hello there friend")).toBeNull();
  });

  it("reports this call's spend via onUsage so it isn't billed-blind", async () => {
    generateTextMock.mockResolvedValue({
      text: "Fix login bug",
      usage: { inputTokens: 1200, outputTokens: 8, cachedInputTokens: 200 },
    });
    const onUsage = vi.fn();
    await generateChatTitle(model, "openai", "the login button is broken", undefined, onUsage);
    // Billable input excludes the cached portion (see toTokenUsage).
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 1000, outputTokens: 8, cachedInputTokens: 200 });
  });

  it("does not call onUsage when the provider reports no usage", async () => {
    generateTextMock.mockResolvedValue({ text: "Fix login bug" });
    const onUsage = vi.fn();
    await generateChatTitle(model, "openai", "the login button is broken", undefined, onUsage);
    expect(onUsage).not.toHaveBeenCalled();
  });
});
