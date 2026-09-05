import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Streamed text is never made unreadable to signal that it is still streaming.
 *
 * Reasoning rows used to blur their last ~18 characters behind an alpha mask. That
 * swallowed a whole extra line whenever the tail contained a newline (reasoning is
 * `whitespace-pre-wrap`), and since a reasoning part carries no streaming/done
 * state (`contracts.ts`) the blur was driven by position in the rail and sat frozen
 * over final text. Liveness belongs to the pacing of the deltas, the ticking duration and the step
 * spinner — never to degrading the text. Invisible to types and lint, so checked
 * here.
 */
const CSS = "src/app/globals.css";
const MESSAGE = "src/components/chat/message.tsx";

describe("streamed text", () => {
  const css = readFileSync(CSS, "utf8");
  const message = readFileSync(MESSAGE, "utf8");

  it("has no blur/mask tail class left to apply", () => {
    expect(css).not.toMatch(/\.stream-tail\b/);
    expect(message).not.toMatch(/\bstream-tail\b/);
  });

  it("puts no filter, mask or caret on the streaming surface", () => {
    // Liveness is carried by the pacing of the deltas (delta-pacer.ts), the
    // ticking duration and the step spinner — the text itself is left alone.
    expect(css).not.toMatch(/\.chat-prose\[data-streaming\]/);
    const prose = css.slice(css.indexOf(".chat-prose"));
    expect(prose.slice(0, prose.indexOf("}"))).not.toMatch(/filter|mask-image|opacity:\s*0(\.0*)?[;\s]/);
  });

  it("renders reasoning whole, not as a per-character split", () => {
    // A tail requires slicing the thought into "settled" + "arriving" halves.
    // No slice, no tail — and no re-render cost proportional to stream speed.
    // (The thought is markdown now, so the whole of it goes to one renderer;
    // what's forbidden is cutting it into a settled and an arriving half.)
    const row = message.slice(message.indexOf("function ReasoningRow"));
    const body = row.slice(0, row.indexOf("\n}"));
    expect(body).not.toMatch(/\.slice\(/);
    expect(body).toContain(">{clean}</Markdown>");
  });
});
