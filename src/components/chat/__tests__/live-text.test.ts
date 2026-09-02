import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A streamed answer reads as live text, not as text arriving in slabs.
 *
 * The runner flushes every ~100ms and the client coalesces deltas into ~250ms
 * batches, so without any treatment a paragraph grows in jumps of twenty to forty
 * tokens four times a second. Streamdown's per-word entrance is what turns those
 * jumps back into a flow: only the words mounted by the latest batch animate, and
 * when `isAnimating` goes false the plugin leaves the pipeline, so a finished
 * message carries no extra spans. These facts are invisible to types and lint.
 */
const CSS = "src/app/globals.css";
const MARKDOWN = "src/components/chat/markdown.tsx";
const MESSAGE = "src/components/chat/message.tsx";

describe("live text", () => {
  const css = readFileSync(CSS, "utf8");
  const markdown = readFileSync(MARKDOWN, "utf8");
  const message = readFileSync(MESSAGE, "utf8");

  it("animates newly mounted words while streaming, through Streamdown's own plugin", () => {
    expect(markdown).toMatch(/isAnimating=\{isStreaming\}/);
    // The options object must be a module-level constant: Streamdown's memo
    // compares `animated` by reference, and a literal per render would re-render
    // every block of every message on each keystroke in the composer.
    expect(markdown).toMatch(/animated=\{[A-Z_]+\}/);
    expect(markdown).toMatch(/const [A-Z_]+ = \{[^}]*sep: "word"/);
  });

  it("does not remount the whole markdown tree when a turn ends", () => {
    // Remounting re-parses every block and re-runs the highlighter at the very
    // moment the eye is on the last line. The key may still carry the citation
    // identity (the comparator really does ignore `remarkPlugins`), but it must
    // not flip on the streaming state.
    const key = markdown.slice(markdown.indexOf("key={`"), markdown.indexOf("`}", markdown.indexOf("key={`")));
    expect(key).not.toContain("isStreaming");
    // …and nothing memoised on `isStreaming` feeds Streamdown a new `components`
    // object at that moment either.
    const deps = markdown.match(/\[chatId, isStreaming, citeKey\]/);
    expect(deps).toBeNull();
  });

  it("the caret is still while words arrive and blinks only when they pause", () => {
    // The base caret rule carries no animation: a bar blinking under visibly
    // growing text is a glitch, not a signal.
    const base = css.slice(css.indexOf(".chat-prose[data-streaming] > p:last-child::after"));
    expect(base.slice(0, base.indexOf("}"))).not.toMatch(/animation/);
    // A pause (a tool call, the model thinking) is the one moment a blink carries
    // information — "still here, waiting on the next word".
    expect(css).toMatch(/\.chat-prose\[data-streaming\]\[data-paused\] > p:last-child::after\s*\{[^}]*animation:[^}]*caret-blink[^}]*step-end/);
    expect(css).toMatch(/@keyframes caret-blink/);
    expect(message).toMatch(/data-paused=/);
  });
});
