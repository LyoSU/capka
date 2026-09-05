import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A theme change is one repaint, not hundreds of colour fades.
 *
 * Every surface carries a `transition` on its colours for hover and press. When
 * the theme flips, all of those fire at once on different durations, and the page
 * shimmers through mismatched intermediate colours for a few hundred
 * milliseconds. The provider freezes transitions for the frames the flip takes.
 */
describe("theme switch", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const providers = readFileSync("src/components/providers.tsx", "utf8");

  it("has a rule that freezes every transition while the class is on the root", () => {
    const rule = css.slice(css.indexOf(".theme-switching"));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/transition:\s*none\s*!important/);
  });

  it("puts the class on for the flip and takes it off again", () => {
    const fn = providers.slice(providers.indexOf("function withFrozenTransitions"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/classList\.add\("theme-switching"\)/);
    expect(body).toMatch(/classList\.remove\("theme-switching"\)/);
    // Both the explicit choice and a system-theme change go through it.
    expect(providers.match(/withFrozenTransitions\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
