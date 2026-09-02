import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The activity rail unfolds; it does not appear.
 *
 * One entrance for every row and for the controls that follow an answer: a short
 * rise of a few pixels on the app's micro-interaction curve, cascaded by `--i` when
 * several mount together. The hairline between two steps grows down from the
 * glyph above it instead of being there already, so the rail reads as one line
 * being drawn. None of this is visible to types or lint.
 */
const CSS = "src/app/globals.css";
const MESSAGE = "src/components/chat/message.tsx";

describe("rail rhythm", () => {
  const css = readFileSync(CSS, "utf8");
  const message = readFileSync(MESSAGE, "utf8");

  it("defines one fade-up entrance, cascaded by --i on the micro-interaction curve", () => {
    expect(css).toMatch(/@keyframes fade-up\s*\{[^}]*translateY\(8px\)/);
    const rule = css.slice(css.indexOf(".animate-fade-up {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toMatch(/fade-up/);
    expect(body).toMatch(/var\(--ease-strong\)/);
    expect(body).toMatch(/var\(--i/);
  });

  it("the hairline between steps is drawn downward, not present from the start", () => {
    expect(css).toMatch(/@keyframes rail-grow\s*\{[^}]*scaleY\(0\)/);
    const rule = css.slice(css.indexOf(".animate-rail-grow {"));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/transform-origin:\s*top/);
    // Hung from the glyph in StepRow — the one place the line exists.
    const step = message.slice(message.indexOf("function StepRow"), message.indexOf("function ActivityRail"));
    expect(step).toMatch(/connect && !open && <span[^>]*animate-rail-grow/);
  });

  it("rows enter with fade-up and a stagger index computed against what was already mounted", () => {
    const step = message.slice(message.indexOf("function StepRow"), message.indexOf("function ActivityRail"));
    expect(step).toMatch(/animate-fade-up/);
    expect(step).not.toMatch(/animate-step-in group\/step/);
    const reasoning = message.slice(message.indexOf("function ReasoningRow"), message.indexOf("function StepGlyph"));
    expect(reasoning).toMatch(/animate-fade-up/);
    const rail = message.slice(message.indexOf("function ActivityRail"), message.indexOf("function ActivityGroup"));
    expect(rail).toMatch(/staggerIndex\(/);
  });

  it("the controls under a finished answer rise in the same register", () => {
    // Previously `animate-message-in` (4px) with an ad-hoc `--settle` delay; now the
    // shared entrance with its cascade index doing the settling.
    const tail = message.slice(message.indexOf("{!isStreaming && (() => {"));
    expect(tail).toMatch(/animate-fade-up/);
  });
});
