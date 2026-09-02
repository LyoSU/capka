import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A markdown table in an answer reads as part of the answer, not as a widget.
 *
 * Seen on the real CSS bundle: a grey band across the header, three orphaned
 * icons floating above the table with a gap of their own, body text a size
 * smaller than the prose, and a table stretched to the column's full width so all
 * the slack landed in one column and pushed the last one to the far edge. None of
 * this is visible to types or lint, so the rules are pinned here.
 */
const CSS = "src/app/globals.css";

function rule(css: string, selector: string): string {
  const i = css.indexOf(selector);
  expect(i, `rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", i);
  return css.slice(open, css.indexOf("}", open));
}

describe("markdown tables", () => {
  const css = readFileSync(CSS, "utf8");

  it("the header is a rule under the labels, not a band behind them", () => {
    expect(rule(css, '[data-streamdown="table-header"] {')).toMatch(/background:\s*(transparent|none)/);
  });

  it("the table takes its content width; a short table is not stretched across the column", () => {
    expect(rule(css, '[data-streamdown="table"] {')).not.toMatch(/min-width:\s*100%/);
  });

  it("cells read at nearly the prose size and line up their digits", () => {
    const cells = rule(css, '[data-streamdown="table-header-cell"],\n[data-streamdown="table-cell"] {');
    expect(cells).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(cells).toMatch(/font-size:\s*0\.9375rem/);
  });

  it("the controls are out of the way at rest on a pointer device and reachable on touch", () => {
    // Faint at rest was still three icons hanging in the air above every table.
    // With a real hover available they appear on hover only; a touch screen, which
    // has no hover, keeps them faintly visible so they can be found.
    expect(css).toMatch(/@media \(hover: hover\)[^{]*\{[^]*?\[data-streamdown="table-wrapper"\] > :first-child:not\(:last-child\)\s*\{[^}]*opacity:\s*0;/);
  });
});
