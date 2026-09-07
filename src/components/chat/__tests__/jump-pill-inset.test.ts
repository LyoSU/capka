import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The jump pill rests on top of the composer's footer, and the two have to move
 * as one object.
 *
 * The keyboard inset is the only thing that moves them independently, and it used
 * to reach the pill through `bottom`, which nothing transitions, while the footer
 * carries it on a 200ms `transition-transform`. So the inset CHANGING dropped the
 * pill the whole distance in one frame and it landed inside the composer card
 * until the footer's glide caught up. Measured in a DOM harness on the real
 * compiled CSS, at a 300px inset: the 36px gap read −264px on the first frame
 * after the keyboard closed, and was back to 36px by about 60ms.
 *
 * None of that is visible to types and it leaves no trace in a passing render, so
 * the shape is pinned here: same property, same duration, same curve, and the
 * inset nowhere near `bottom`.
 */
const pill = readFileSync("src/components/chat/jump-pill.tsx", "utf8");
const panel = readFileSync("src/components/chat/chat-panel.tsx", "utf8");

/** The wrapper's own className line. Assertions about the pill's positioning
 *  belong here rather than on the whole file, whose comments name the very
 *  classes under test. */
function wrapperClasses(): string {
  const line = pill
    .split("\n")
    .find((l) => l.includes('className="pointer-events-none absolute left-1/2'));
  if (!line) throw new Error("the jump pill's wrapper class line was not found");
  return line;
}

describe("the jump pill tracks the footer it rests on", () => {
  it("carries the keyboard inset on a transform, not in `bottom`", () => {
    expect(pill).toMatch(/transform: "translate\(-50%, calc\(-1 \* var\(--kb, 0px\)\)\)"/);
    // `bottom` is the measured reserve and nothing else.
    expect(pill).toMatch(/bottom: `\$\{bottom \+ 4\}px`/);
    expect(pill).not.toMatch(/bottom: `calc\([^`]*--kb/);
  });

  it("transitions the same property, duration and curve as the footer", () => {
    // On the WRAPPER's class line, not anywhere in the file: the comment above it
    // quotes the footer's class, so a file-wide match would pass even with the
    // transition deleted. It read True against a deliberately broken copy, which
    // is how it was caught.
    expect(wrapperClasses()).toMatch(/transition-transform duration-200 ease-out/);
    // The footer's own class, which is what the pill is matching.
    expect(panel).toMatch(/transition-transform duration-200 ease-out/);
  });

  it("does not centre with a class beside an inline transform", () => {
    // A `-translate-x-1/2` class is simply overwritten by the inline transform,
    // which would leave the pill off-centre by half its width. Scoped to the
    // WRAPPER's own class line: the button's `before:-translate-x-1/2` centres a
    // pseudo-element and is none of this test's business.
    expect(wrapperClasses()).not.toMatch(/-translate-x-1\/2/);
    expect(pill).toMatch(/translate\(-50%,/);
  });
});
