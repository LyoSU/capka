import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The model picker's panel must escape its ancestors, not negotiate with them.
 *
 * An `absolute` panel is still clipped by the nearest ancestor whose overflow
 * isn't `visible`. The `field` variant sits inside a `SettingsGroup`, whose
 * `overflow-hidden` chopped a 480px panel down to what was left of a 66px card
 * row — the project Settings tab showed a sliver with no way to pick a model.
 * The fix (portal to <body> + position:fixed) is invisible to types and lint,
 * and the tempting wrong fix — measure ancestor clip rects and shrink the panel
 * to fit — reads as deliberate care while still rendering into a hard clip.
 * So the invariant is checked here instead.
 */
const SRC = "src/components/chat/model-picker.tsx";

describe("model picker panel", () => {
  const src = readFileSync(SRC, "utf8");

  it("is never positioned in the normal flow, where an overflow ancestor clips it", () => {
    const inFlow = [...src.matchAll(/className={?[`"]([^`"]*\bbg-popover\b[^`"]*)/g)]
      .map(([, classes]) => classes)
      .filter((classes) => /\babsolute\b/.test(classes));
    expect(inFlow).toEqual([]);
  });

  it("is portaled out, and excluded from the outside-click check that would eat its own clicks", () => {
    // `bg-popover shadow-overlay` is the panel surface itself — plain `bg-popover`
    // also matches the sticky group header rendered inside its list.
    const panel = src.indexOf("bg-popover shadow-overlay");
    expect(panel).toBeGreaterThan(-1);
    // The panel is no longer a DOM descendant of containerRef, so a click on a
    // model row counts as "outside" unless popoverRef marks the portaled subtree.
    const portal = src.lastIndexOf("createPortal(", panel);
    expect(portal).toBeGreaterThan(-1);
    expect(src.slice(portal, panel)).toContain("ref={popoverRef}");
  });
});
