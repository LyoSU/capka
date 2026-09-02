import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Selection and hover GLIDE between rows instead of switching on and off.
 *
 * A highlight that is a single element moving between targets says "the same
 * thing moved" — the eye follows it — where a per-row background that lights up
 * and goes out reads as two unrelated events. One glider per list, absolutely
 * positioned, moving on the micro-interaction curve; the rows themselves carry no
 * hover fill of their own any more. Reduced motion collapses the transition to an
 * instant move through the global reset.
 */
const NAV = "src/components/chat/chat-nav.tsx";
const ASK = "src/components/chat/ask-card.tsx";

describe("gliding highlight — chat navigator", () => {
  const nav = readFileSync(NAV, "utf8");

  it("has exactly one glider, moving on top/height with the micro-interaction curve", () => {
    const gliders = nav.match(/aria-hidden[^>]*transition-\[top,height/g) ?? nav.match(/transition-\[top,height[^>]*aria-hidden/g) ?? [];
    expect(gliders).toHaveLength(1);
    expect(nav).toMatch(/transition-\[top,height[^"]*\]/);
    expect(nav).toMatch(/--ease-strong/);
  });

  it("follows the pointer and keyboard focus alike, and rows carry no hover fill of their own", () => {
    expect(nav).toMatch(/onMouseEnter=/);
    expect(nav).toMatch(/onFocus=/);
    expect(nav).not.toMatch(/hover:bg-hover/);
  });
});

describe("gliding selection — ask card", () => {
  const ask = readFileSync(ASK, "utf8");

  it("a single choice is marked by one pill that glides between the options", () => {
    expect(ask).toMatch(/transition-\[left,top,width,height[^"]*\]/);
    expect(ask).toMatch(/pointer-events-none/);
  });

  it("a multi-select keeps a fill per chip — several can be on at once", () => {
    // The glider is one element; it cannot mark three chips. The solid fill stays
    // the multi-select's own treatment.
    expect(ask).toMatch(/multi[^\n]*bg-primary|bg-primary[^\n]*multi/);
  });
});
