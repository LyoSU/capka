import { describe, it, expect } from "vitest";
import { createFrameDemux, encodeFrame } from "./docker-frames.js";

// Replay a byte stream split into chunks of `chunkSize` (1 = adversarial:
// every header and payload byte arrives separately) and return the demuxed result.
function replay(bytes, chunkSize) {
  const demux = createFrameDemux();
  for (let i = 0; i < bytes.length; i += chunkSize) {
    demux.push(bytes.subarray(i, i + chunkSize));
  }
  return demux.result();
}

describe("createFrameDemux", () => {
  it("demuxes stdout and stderr frames delivered whole", () => {
    const bytes = Buffer.concat([
      encodeFrame(1, "out-a "),
      encodeFrame(2, "err-1 "),
      encodeFrame(1, "out-b"),
    ]);
    expect(replay(bytes, bytes.length)).toEqual({ stdout: "out-a out-b", stderr: "err-1 ", truncated: false });
  });

  it("reassembles frames split across chunk boundaries (incl. mid-header, 1-byte chunks)", () => {
    const bytes = Buffer.concat([encodeFrame(1, "hello world"), encodeFrame(2, "oops")]);
    // The previous parser dropped the partial frame at a chunk edge; verify byte-
    // by-byte delivery still yields the exact output.
    expect(replay(bytes, 1)).toEqual({ stdout: "hello world", stderr: "oops", truncated: false });
    expect(replay(bytes, 3)).toEqual({ stdout: "hello world", stderr: "oops", truncated: false });
    expect(replay(bytes, 7)).toEqual({ stdout: "hello world", stderr: "oops", truncated: false });
  });

  it("caps in-memory output and flags it, draining the rest (RAM guard against runaway commands)", () => {
    const demux = createFrameDemux(50); // tiny ceiling for the test
    demux.push(encodeFrame(1, "x".repeat(50))); // fills the ceiling exactly — kept
    demux.push(encodeFrame(1, "y".repeat(40))); // would cross — dropped & flagged
    const { stdout, truncated } = demux.result();
    expect(truncated).toBe(true);
    expect(stdout).toBe("x".repeat(50)); // overflow frame dropped, not appended
  });

  it("flags a SINGLE frame bigger than the ceiling instead of keeping it whole", () => {
    // A lone oversized frame used to sail past the cap unflagged (the total was
    // only checked before adding), defeating the RAM guard by up to one frame.
    const demux = createFrameDemux(50);
    demux.push(encodeFrame(1, "x".repeat(60)));
    const { stdout, truncated } = demux.result();
    expect(truncated).toBe(true);
    expect(stdout).toBe("");
  });

  it("does not truncate large multi-frame output spanning many chunks", () => {
    const big = "x".repeat(50_000);
    const bytes = Buffer.concat([encodeFrame(1, big), encodeFrame(1, big)]);
    const { stdout } = replay(bytes, 4096);
    expect(stdout.length).toBe(100_000);
  });

  it("decodes a multi-byte UTF-8 char split across two frames", () => {
    // "é" is 0xC3 0xA9; put each byte in its own stdout frame.
    const bytes = Buffer.concat([
      encodeFrame(1, "caf"),
      Buffer.concat([(() => { const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(1, 4); return h; })(), Buffer.from([0xc3])]),
      Buffer.concat([(() => { const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(1, 4); return h; })(), Buffer.from([0xa9])]),
    ]);
    expect(replay(bytes, 1).stdout).toBe("café");
  });
});
