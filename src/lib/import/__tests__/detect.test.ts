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

  it("accepts a grok.com share link (base64-prefix + uuid id)", () => {
    const r = detectShareLink("https://grok.com/share/bGVnYWN5LWNvcHk_8ad414c5-a79a-4a3e-a66c-e5d5b7dd8331");
    expect(r).toEqual({ source: "grok", url: "https://grok.com/share/bGVnYWN5LWNvcHk_8ad414c5-a79a-4a3e-a66c-e5d5b7dd8331" });
  });

  it("accepts the canonical gemini.google.com/share/<hex> link", () => {
    const r = detectShareLink("https://gemini.google.com/share/e96b26ad024d");
    expect(r).toEqual({ source: "gemini", url: "https://gemini.google.com/share/e96b26ad024d" });
  });

  it("accepts the short share.gemini.google/<id> link (no /share segment)", () => {
    const r = detectShareLink("https://share.gemini.google/rY1hvyvGvtIQ");
    expect(r).toEqual({ source: "gemini", url: "https://share.gemini.google/rY1hvyvGvtIQ" });
  });

  it("rejects a non-hex gemini canonical id", () => {
    expect(detectShareLink("https://gemini.google.com/share/ZZZnothexZZZ")).toBeNull();
  });

  it("rejects a /share path on the short gemini host (short host has no /share)", () => {
    expect(detectShareLink("https://share.gemini.google/share/rY1hvyvGvtIQ")).toBeNull();
  });

  it("rejects a too-short grok id", () => {
    expect(detectShareLink("https://grok.com/share/abc")).toBeNull();
  });

  it("rejects a look-alike gemini subdomain host", () => {
    expect(detectShareLink("https://gemini.google.com.evil.example/share/e96b26ad024d")).toBeNull();
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
