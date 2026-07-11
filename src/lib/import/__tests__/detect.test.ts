import { describe, it, expect } from "vitest";
import { detectShareLink } from "../detect";

describe("detectShareLink", () => {
  it("accepts a claude.ai share link and canonicalizes it", () => {
    const r = detectShareLink("https://claude.ai/share/ae04f45b-facf-49f8-8e9d-020f48adebb8");
    expect(r).toEqual({ source: "claude", url: "https://claude.ai/share/ae04f45b-facf-49f8-8e9d-020f48adebb8" });
  });

  it("accepts a chatgpt.com share link", () => {
    const r = detectShareLink("https://chatgpt.com/share/6a528715-caf8-83ed-a7e4-15ca15c0a580");
    expect(r?.source).toBe("chatgpt");
  });

  it("accepts the chatgpt 'e/' enterprise share variant", () => {
    const r = detectShareLink("https://chatgpt.com/share/e/6a528715-caf8-83ed-a7e4-15ca15c0a580");
    expect(r?.source).toBe("chatgpt");
  });

  it("accepts the legacy chat.openai.com host", () => {
    const r = detectShareLink("https://chat.openai.com/share/6a528715-caf8-83ed-a7e4-15ca15c0a580");
    expect(r?.source).toBe("chatgpt");
  });

  it("strips query, hash and trailing slash", () => {
    const r = detectShareLink("https://claude.ai/share/ae04f45b-facf-49f8-8e9d-020f48adebb8/?utm=x#frag");
    expect(r?.url).toBe("https://claude.ai/share/ae04f45b-facf-49f8-8e9d-020f48adebb8");
  });

  it("tolerates surrounding whitespace", () => {
    expect(detectShareLink("  https://claude.ai/share/ae04f45b-facf-49f8-8e9d-020f48adebb8  ")?.source).toBe("claude");
  });

  it("rejects a link buried in other text (only a bare link counts)", () => {
    expect(detectShareLink("look at https://claude.ai/share/ae04f45b-facf-49f8-8e9d-020f48adebb8 please")).toBeNull();
  });

  it("rejects a non-share path on an allowed host", () => {
    expect(detectShareLink("https://claude.ai/chat/ae04f45b-facf-49f8-8e9d-020f48adebb8")).toBeNull();
  });

  it("rejects an unknown host", () => {
    expect(detectShareLink("https://evil.example/share/ae04f45b-facf-49f8-8e9d-020f48adebb8")).toBeNull();
  });

  it("rejects a look-alike subdomain host", () => {
    expect(detectShareLink("https://claude.ai.evil.example/share/ae04f45b-facf-49f8-8e9d-020f48adebb8")).toBeNull();
  });

  it("rejects non-URL input", () => {
    expect(detectShareLink("just some text")).toBeNull();
    expect(detectShareLink("")).toBeNull();
  });
});
