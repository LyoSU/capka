import { describe, it, expect, vi } from "vitest";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";
import { openFenceBody, deferLiveHighlight } from "../live-code";

describe("openFenceBody", () => {
  it("is null for prose and for a closed fence", () => {
    expect(openFenceBody("Just words.\n\nMore words.")).toBeNull();
    expect(openFenceBody("Before\n\n```js\nconst a = 1;\n```\n\nAfter")).toBeNull();
  });

  it("returns the body of the fence the text ends inside, trailing newlines stripped", () => {
    expect(openFenceBody("Intro\n\n```py\nimport os\nprint(1)\n")).toBe("import os\nprint(1)");
    expect(openFenceBody("```\nx")).toBe("x");
  });

  it("is the empty string right after the opening line, so a block with no lines yet still defers", () => {
    expect(openFenceBody("```ts\n")).toBe("");
  });

  it("only a fence at least as long closes a longer one, so a ``` inside a ```` block stays inside", () => {
    expect(openFenceBody("````md\n```js\nlet a\n```\nstill inside\n")).toBe("```js\nlet a\n```\nstill inside");
    expect(openFenceBody("````md\n```js\n```\n````\n")).toBeNull();
  });

  it("handles ~~~ fences and does not mix the two characters", () => {
    expect(openFenceBody("~~~\ncode\n```\n")).toBe("code\n```");
    expect(openFenceBody("~~~\ncode\n~~~\n")).toBeNull();
  });

  it("does not treat inline code or a closed earlier block as an open fence", () => {
    expect(openFenceBody("Use `npm run dev` here.")).toBeNull();
    expect(openFenceBody("```sh\nnpm run dev\n```\n\nThen edit ```x")).toBeNull();
  });
});

describe("deferLiveHighlight", () => {
  const inner: CodeHighlighterPlugin = {
    name: "shiki",
    type: "code-highlighter",
    getSupportedLanguages: () => [],
    getThemes: () => ["github-light", "github-dark"],
    supportsLanguage: () => true,
    highlight: vi.fn(() => null),
  };

  it("returns plain per-line tokens synchronously for the live block and never asks shiki", () => {
    const plugin = deferLiveHighlight(inner, (code) => code === "a\nb");
    const cb = vi.fn();
    const result = plugin.highlight({ code: "a\nb", language: "ts", themes: ["github-light", "github-dark"] }, cb);
    expect(inner.highlight).not.toHaveBeenCalled();
    expect(result?.tokens.map((line) => line.map((t) => t.content).join(""))).toEqual(["a", "b"]);
    expect(cb).not.toHaveBeenCalled();
  });

  it("delegates every other block to the real highlighter, callback included", () => {
    const plugin = deferLiveHighlight(inner, () => false);
    const cb = vi.fn();
    const opts: HighlightOptions = { code: "done", language: "ts", themes: ["github-light", "github-dark"] };
    plugin.highlight(opts, cb);
    expect(inner.highlight).toHaveBeenCalledWith(opts, cb);
  });

  it("keeps the plugin's identity fields, so Streamdown still recognises it", () => {
    const plugin = deferLiveHighlight(inner, () => false);
    expect(plugin.name).toBe("shiki");
    expect(plugin.type).toBe("code-highlighter");
  });
});
