import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A streamed answer reads as live text because the DELTAS are paced; the per-word
 * fade sits on top of that pacing and must never stand in for it.
 *
 * The runner flushes every ~100ms; shown as they land, a paragraph grows in slabs
 * of twenty-odd tokens. A fade on each slab is what once read as «блимає»: four
 * slabs a second, each flashing in from transparent, plus a caret flickering
 * between them. `delta-pacer.ts` now releases whole words at a steady cadence
 * upstream of the renderer, and a fade on each PACED word turns the leading edge
 * into a soft gradient rather than a hard front. The caret stays gone. These
 * facts are invisible to types and lint, so they are pinned here.
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

  it("fades each paced word in once, with no per-block cascade", () => {
    // Streamdown animates only the words past the previous render's length and
    // skips code/pre/math, so with paced deltas each new word fades in alone. The
    // plugin staggers per BLOCK, so any stagger > 0 restarts the cascade in every
    // paragraph and a reply grows two fronts at once — it must stay at 0.
    expect(markdown).toMatch(/isAnimating=\{isStreaming\}/);
    expect(markdown).toMatch(/animated=\{ANIMATED\}/);
    const animated = markdown.slice(markdown.indexOf("const ANIMATED = {"), markdown.indexOf("} as const;"));
    expect(animated).toMatch(/animation: "fadeIn"/);
    expect(animated).toMatch(/sep: "word"/);
    expect(animated).toMatch(/stagger: 0\b/);
    // Only the words animate. No blur, no mask — see streamed-text-legibility.
    expect(animated).not.toMatch(/blur/i);
  });

  it("defers highlighting of the code block still being streamed, keyed on the fence, not the token", () => {
    // The highlighter re-tokenizes a block on every render of it; the growing
    // block is handed back plain until its fence closes. The plugin object's
    // identity must flip only on the fence boundary — per token would re-run every
    // block's highlighter effect on every word.
    expect(markdown).toMatch(/deferLiveHighlight\(/);
    expect(markdown).toMatch(/\}, \[ready, inFence\]\);/);
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
