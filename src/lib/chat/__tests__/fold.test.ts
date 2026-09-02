import { describe, it, expect } from "vitest";
import { foldableCount, placeholderPx } from "@/lib/chat/fold";

/**
 * Long transcripts fold their older messages out of layout and paint.
 *
 * The recent tail stays fully rendered — it is what the reader is looking at and
 * what the scroll engine measures against — and everything before it becomes a
 * `content-visibility: auto` placeholder. The placeholder's height is the message's
 * OWN measured height, because a guessed one moves the page under a reader
 * scrolling up: measured in a harness, a 120px guess produced jumps of up to 2500px,
 * a border-box measurement left a 33px jolt (exactly padding plus border), and the
 * content-box measurement produced none in sixty steps.
 */
describe("foldableCount", () => {
  it("folds nothing in a short chat", () => {
    expect(foldableCount(0)).toBe(0);
    expect(foldableCount(1)).toBe(0);
    expect(foldableCount(20)).toBe(0);
  });

  it("keeps the recent tail rendered and folds everything before it", () => {
    expect(foldableCount(21)).toBe(1);
    expect(foldableCount(120)).toBe(100);
  });

  it("takes the tail length as a parameter", () => {
    expect(foldableCount(30, 10)).toBe(20);
  });
});

describe("placeholderPx", () => {
  it("is the content-box height: padding is not part of contain-intrinsic-size", () => {
    expect(placeholderPx({ clientHeight: 233, paddingTop: 16, paddingBottom: 16 })).toBe(201);
  });

  it("passes an unpadded box through unchanged", () => {
    expect(placeholderPx({ clientHeight: 88, paddingTop: 0, paddingBottom: 0 })).toBe(88);
  });

  it("never goes below zero on a degenerate box", () => {
    expect(placeholderPx({ clientHeight: 0, paddingTop: 8, paddingBottom: 8 })).toBe(0);
  });
});
