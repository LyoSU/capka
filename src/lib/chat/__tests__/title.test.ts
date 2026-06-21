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
});

describe("generateChatTitle", () => {
  it("returns a sanitized title from the model", async () => {
    generateTextMock.mockResolvedValue({ text: '  "Fix login bug"  ' });
    expect(await generateChatTitle(model, "the login button is broken")).toBe("Fix login bug");
  });

  it("skips empty user input without calling the model", async () => {
    expect(await generateChatTitle(model, " ")).toBeNull();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("returns null (keeps the placeholder) when the model abstains", async () => {
    generateTextMock.mockResolvedValue({ text: "-" });
    expect(await generateChatTitle(model, "hello there friend")).toBeNull();
  });
});
