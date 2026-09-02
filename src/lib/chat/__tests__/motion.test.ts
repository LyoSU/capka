import { describe, it, expect } from "vitest";
import { staggerIndex } from "@/lib/chat/motion";

/**
 * Rows that mount TOGETHER cascade; a row that arrives alone does not wait.
 *
 * The activity rail has two very different entrances. Opening a finished spoiler
 * (or a chat with history) mounts every row in one commit, and a short cascade is
 * what makes that read as a list unfolding rather than a block appearing. A live
 * turn mounts one row every few seconds, and a stagger there would delay each new
 * step by its position in the list — the twentieth action would appear more than a
 * second after it actually happened.
 */
describe("staggerIndex", () => {
  it("cascades rows mounted in the same commit from zero", () => {
    expect(staggerIndex(0, 0)).toBe(0);
    expect(staggerIndex(1, 0)).toBe(1);
    expect(staggerIndex(3, 0)).toBe(3);
  });

  it("gives a row streamed onto an existing rail no delay at all", () => {
    // Seven rows were already on screen; the eighth is new and must not wait.
    expect(staggerIndex(7, 7)).toBe(0);
    expect(staggerIndex(20, 20)).toBe(0);
  });

  it("caps the cascade so a long history still finishes unfolding promptly", () => {
    expect(staggerIndex(40, 0)).toBe(6);
    expect(staggerIndex(9, 3)).toBe(6);
  });

  it("never goes negative for a row that was already there", () => {
    expect(staggerIndex(2, 5)).toBe(0);
  });
});
