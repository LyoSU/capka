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

/** The rule that drives the pinned column's seam from the scroller's own inline
 *  scroll position (the file mentions scroll timelines in prose elsewhere, so the
 *  declaration itself is what is looked for). */
function pinnedShadow(css: string): string {
  const i = css.indexOf("animation-timeline: scroll(nearest inline)");
  expect(i, "a scroll-driven rule").toBeGreaterThan(-1);
  const open = css.lastIndexOf("{", i);
  const selector = css.slice(css.lastIndexOf("}", open) + 1, open);
  expect(selector).toMatch(/table-cell"\]:first-child/);
  return css.slice(open, css.indexOf("}", i));
}

describe("markdown tables", () => {
  const css = readFileSync(CSS, "utf8");

  it("the header is a rule under the labels, not a band behind them", () => {
    expect(rule(css, '[data-streamdown="table-header"] {')).toMatch(/background:\s*(transparent|none)/);
  });

  it("a table fills the text column; a wider one centres and grows into both margins", () => {
    // The scroller is wider than the column by the bleed and `--table-wide` on
    // each side; the table's minimum is the column itself, so a short table starts
    // on the answer's text edge, and auto margins centre anything wider.
    const table = rule(css, '[data-streamdown="table"] {');
    expect(table).toMatch(/min-width:\s*calc\(100% - 2 \* var\(--table-wide, 0px\)\)/);
    expect(table).toMatch(/margin-inline:\s*auto/);
    // A flex item shrinks by default, and a table shrinks by wrapping every cell.
    expect(table).toMatch(/flex:\s*none/);
    expect(rule(css, '[data-streamdown="table-wrapper"] > :last-child {')).toMatch(/display:\s*flex/);
  });

  it("cells read at nearly the prose size and line up their digits", () => {
    const cells = rule(css, '[data-streamdown="table-header-cell"],\n[data-streamdown="table-cell"] {');
    expect(cells).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(cells).toMatch(/font-size:\s*0\.9375rem/);
  });

  it("the first column stays put while a wide table scrolls sideways — on wide screens only", () => {
    // With a trackpad the labels stay while the columns move. On a phone the pin
    // was tried and rejected: the label column took half the screen. So the pin
    // lives inside a min-width media query, and the bare first-cell rule carries
    // no position of its own.
    const bare = rule(css, '[data-streamdown="table-header-cell"]:first-child,\n[data-streamdown="table-cell"]:first-child {');
    expect(bare).not.toMatch(/position:/);
    const wide = css.slice(css.indexOf("@media (min-width: 768px) {\n  [data-streamdown=\"table-header-cell\"]:first-child"));
    expect(wide.length).toBeGreaterThan(0);
    const pinned = wide.slice(wide.indexOf("{", wide.indexOf("first-child {")), wide.indexOf("}"));
    expect(pinned).toMatch(/position:\s*sticky/);
    expect(pinned).toMatch(/left:\s*0/);
    expect(pinned).toMatch(/background:\s*var\(--background\)/);
  });

  it("the pinned column casts a shadow only once something has scrolled under it", () => {
    // A resting table shows no seam; one that has scrolled shows where the cut is,
    // so a number whose first digits slid under the label column reads as cut
    // rather than as wrong. Scroll-driven, no JS; browsers without it keep the
    // pinned column and simply show no seam.
    expect(css).toMatch(/@keyframes table-pin-shadow/);
    expect(pinnedShadow(css)).toMatch(/animation-timeline:\s*scroll\(nearest inline\)/);
  });

  it("on a wide screen the table's scroller spans the free width on both sides", () => {
    // The column is 48–56rem in a window that is often twice that; a wide table
    // had to scroll inside the column with empty page on both sides. The scroller
    // extends into both margins by `--table-wide`, which the panel derives from the
    // transcript's own width in container units, uncapped. A right-only version
    // was tried and read as lopsided.
    const scroller = rule(css, '[data-streamdown="table-wrapper"] > :last-child {');
    expect(scroller).toMatch(/margin-inline:\s*calc\(-1 \* \(var\(--table-bleed, 0px\) \+ var\(--table-wide, 0px\)\)\)/);
    const panel = readFileSync("src/components/chat/chat-panel.tsx", "utf8");
    expect(panel).toMatch(/\[container-type:inline-size\]/);
    expect(panel).toMatch(/lg:\[--table-wide:max\(0px,calc\(/);
    expect(panel).not.toMatch(/--table-wide:max\(0px,min\(/);
  });

  it("the fullscreen view is the same table, not Streamdown's boxed default", () => {
    // Streamdown portals the same rows into a fixed pane with its own classes: a
    // bordered box and a sticky header with no ground of its own. The pane gets
    // the transcript's treatment — no box — and the sticky header an opaque ground
    // so rows do not show through it while scrolling.
    const table = rule(css, '[data-streamdown="table-fullscreen"] [data-streamdown="table"] {');
    expect(table).toMatch(/border:\s*none/);
    const head = rule(css, '[data-streamdown="table-fullscreen"] [data-streamdown="table-header"] {');
    expect(head).toMatch(/background:\s*var\(--background\)/);
  });

  it("the controls are out of the way at rest on a pointer device and reachable on touch", () => {
    // Faint at rest was still three icons hanging in the air above every table.
    // With a real hover available they appear on hover only; a touch screen, which
    // has no hover, keeps them faintly visible so they can be found.
    expect(css).toMatch(/@media \(hover: hover\)[^{]*\{[^]*?\[data-streamdown="table-wrapper"\] > :first-child:not\(:last-child\)\s*\{[^}]*opacity:\s*0;/);
  });
});
