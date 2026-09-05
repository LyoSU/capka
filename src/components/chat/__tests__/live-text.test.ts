import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A streamed answer reads as live text because the DELTAS are paced, not because
 * the words are animated.
 *
 * The runner flushes every ~100ms; shown as they land, a paragraph grows in slabs
 * of twenty-odd tokens. The old cure was a per-word fade on each slab plus a caret
 * that blinked on pauses — which is exactly what read as «блимає»: four slabs a
 * second, each flashing in from transparent, and a bar flickering between them.
 * Now `delta-pacer.ts` releases whole words at a steady cadence upstream of the
 * renderer, and the text itself gets no treatment at all: no fade, no blur, no
 * caret. These facts are invisible to types and lint, so they are pinned here.
 */
const CSS = "src/app/globals.css";
const MARKDOWN = "src/components/chat/markdown.tsx";
const MESSAGE = "src/components/chat/message.tsx";
const HOOK = "src/hooks/use-background-chat.ts";

describe("live text", () => {
  const css = readFileSync(CSS, "utf8");
  const markdown = readFileSync(MARKDOWN, "utf8");
  const message = readFileSync(MESSAGE, "utf8");
  const hook = readFileSync(HOOK, "utf8");

  it("paces deltas on the client instead of applying each server batch as a slab", () => {
    expect(hook).toMatch(/createDeltaPacer/);
    expect(hook).not.toMatch(/createDeltaCoalescer/);
  });

  it("does not animate words: a paced word needs no entrance", () => {
    // Streamdown's animate plugin wraps every word in a span and fades each
    // batch in from transparent — the flash the pacer exists to remove.
    expect(markdown).not.toMatch(/animated=/);
    expect(markdown).not.toMatch(/isAnimating=/);
  });

  it("draws no caret on the streaming answer", () => {
    expect(css).not.toMatch(/data-streaming/);
    expect(css).not.toMatch(/caret-blink/);
    expect(message).not.toMatch(/data-paused=|data-streaming=|CARET_PAUSE_MS/);
  });

  it("does not remount the whole markdown tree when a turn ends", () => {
    // Remounting re-parses every block and re-runs the highlighter at the very
    // moment the eye is on the last line. The key may still carry the citation
    // identity (the comparator really does ignore `remarkPlugins`), but it must
    // not flip on the streaming state.
    const key = markdown.slice(markdown.indexOf("key={"), markdown.indexOf("}", markdown.indexOf("key={")));
    expect(key).not.toContain("isStreaming");
    const deps = markdown.match(/\[chatId, isStreaming, citeKey\]/);
    expect(deps).toBeNull();
  });
});
