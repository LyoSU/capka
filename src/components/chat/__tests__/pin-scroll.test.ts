import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every layout change under a held pin re-seats the turn; none of them nudges
 * scrollTop by its own delta.
 *
 * The composer's height feeds the scroll area's bottom padding, and a queued
 * `scrollTop += delta` keeps the line you were reading glued above it. That is
 * right while you're reading history — and wrong the instant the pin is holding
 * the newest question on the header line. Sending a message with attachments drops
 * a whole row of preview tiles (~110px) out of the composer exactly as the
 * pin-to-top effect places the question, so the blind delta pushed the question
 * that far down the page. One-line text has a zero delta, which is why the bug
 * read as "attachments scroll differently from text" and showed up on mobile,
 * where the tile row is a bigger share of the viewport.
 *
 * There is no DOM in this suite (vitest runs `environment: node`), so the
 * invariant is checked structurally.
 */
const SRC = "src/components/chat/chat-panel.tsx";

describe("pinned turn", () => {
  const src = readFileSync(SRC, "utf8");

  it("corrects a held pin only through the shared helper", () => {
    // The pin-to-top effect keeps its own arithmetic on purpose — it animates
    // (`behavior: "smooth"`) when a turn is created. Every *correction* after that
    // is instant and must go through one helper; a second copy is how the composer
    // path came to disagree with the content-resize path in the first place.
    expect(src).toContain("const reseatPinned = ()");
    const observer = src.slice(src.indexOf("const ro = new ResizeObserver("));
    expect(observer.slice(0, observer.indexOf("});"))).toContain("if (pinnedRef.current) reseatPinned()");
  });

  it("re-seats instead of shifting when the composer resizes under a held pin", () => {
    const effect = src.slice(src.indexOf("const d = pendingShift.current;"));
    const body = effect.slice(0, effect.indexOf("}, [composerH]);"));
    // The spacer's budget includes the composer, so it must be re-sized before we
    // measure — otherwise the re-seat has nowhere to scroll into.
    expect(body).toContain("resizeSpacer()");
    // Pin wins; the raw delta is the fallback for a released pin only.
    expect(body.indexOf("pinnedRef.current && reseatPinned()")).toBeLessThan(body.indexOf("el.scrollTop += d"));
  });
});
