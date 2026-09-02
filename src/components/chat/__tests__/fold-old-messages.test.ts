import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Older messages are folded only AFTER they have been rendered and measured.
 *
 * `content-visibility: auto` on a never-rendered element gives it a guessed size,
 * and a wrong guess moves the page under a reader scrolling up (see fold.test.ts
 * for the measurements). So the panel never writes the property from a class or a
 * style literal at render time; it sets it imperatively, alongside a
 * `contain-intrinsic-size` taken from the element's own box.
 */
const PANEL = "src/components/chat/chat-panel.tsx";

describe("folding old messages", () => {
  const panel = readFileSync(PANEL, "utf8");

  it("never applies content-visibility from a class or render-time style", () => {
    expect(panel).not.toMatch(/\[content-visibility/);
    expect(panel).not.toMatch(/contentVisibility:\s*"auto"/);
  });

  it("folds imperatively, with a measured placeholder from the same pass", () => {
    const fold = panel.slice(panel.indexOf("placeholderPx("));
    const pass = fold.slice(0, fold.indexOf("\n\n"));
    expect(pass).toMatch(/containIntrinsicSize/);
    expect(pass).toMatch(/contentVisibility = "auto"/);
    expect(panel).toMatch(/foldableCount\(/);
  });
});
