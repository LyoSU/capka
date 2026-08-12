import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Streamed text is never made unreadable to signal that it is still streaming.
 *
 * Reasoning rows used to end in a "dissolving tail": the last ~18 characters wrapped
 * in a span carrying `filter: blur()` + an alpha mask. It failed on both counts it
 * was meant to serve. Reasoning is `whitespace-pre-wrap`, so a newline inside the
 * tail put the single horizontal mask across a whole extra line and swallowed far
 * more than a tail. And a reasoning part carries no streaming/done state
 * (`contracts.ts`), so "is this still arriving?" was inferred from position in the
 * rail — leaving the blur frozen over final text for as long as the model paused
 * before its first answer token.
 *
 * Both failures are invisible to types, lint and unit tests, and the tempting
 * partial fix (shorten the tail, soften the blur) keeps a mask over text the user
 * is trying to read. So the invariant is checked here: liveness is signalled by
 * the caret, the group header's ticking duration and the step spinner — never by
 * degrading the text itself.
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

  it("marks the write head with the caret only — no filter on the streaming surface", () => {
    // The one treatment allowed on live text, and it must stay conditional on
    // `data-streaming` so it disappears the moment text stops arriving.
    expect(css).toContain(".chat-prose[data-streaming] > p:last-child::after");
    const caret = css.slice(css.indexOf(".chat-prose[data-streaming]"));
    const block = caret.slice(0, caret.indexOf("}"));
    expect(block).not.toMatch(/filter|mask-image|opacity:\s*0(\.0*)?[;\s]/);
  });

  it("renders reasoning as plain text, not a per-character split", () => {
    // A tail requires slicing the thought into "settled" + "arriving" halves.
    // No slice, no tail — and no re-render cost proportional to stream speed.
    const row = message.slice(message.indexOf("function ReasoningRow"));
    const body = row.slice(0, row.indexOf("\n}"));
    expect(body).not.toMatch(/\.slice\(/);
    expect(body).toContain(">{clean}</p>"); // the whole thought, one text node
  });
});
