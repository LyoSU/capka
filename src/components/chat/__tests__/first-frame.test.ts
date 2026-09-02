import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Opening an existing chat never shows an empty transcript.
 *
 * The route's loading shell covers the server round-trip, but the panel then
 * mounts with no messages until its own history fetch resolves — a blank middle
 * for as long as that takes, then everything at once. While the server has said
 * the chat HAS history and the client has not received it yet, the transcript
 * shows a quiet skeleton of a conversation's end, where the reader is about to
 * land, and the log is marked busy so a screen reader waits rather than reading
 * an empty region.
 */
const PANEL = "src/components/chat/chat-panel.tsx";

describe("first frame of an existing chat", () => {
  const panel = readFileSync(PANEL, "utf8");

  it("shows a transcript skeleton only while known history has not arrived", () => {
    expect(panel).toMatch(/const showSkeleton = initialHasHistory && !historyLoaded && messages\.length === 0/);
    expect(panel).toMatch(/\{showSkeleton && <TranscriptSkeleton \/>\}/);
  });

  it("the skeleton is decorative and the log is busy until history lands", () => {
    const skel = panel.slice(panel.indexOf("function TranscriptSkeleton"));
    expect(skel.slice(0, skel.indexOf("\n}"))).toMatch(/aria-hidden/);
    expect(panel).toMatch(/aria-busy=\{isLoading \|\| showSkeleton \|\| undefined\}/);
  });
});
