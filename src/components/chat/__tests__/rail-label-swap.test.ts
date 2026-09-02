import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The activity spoiler's label changes KIND once per turn — "Thinking…" or a live
 * stopwatch becomes "Reasoned for 58s · 4 actions" — and that swap fades in like
 * the status row's label already does, rather than snapping. But the live label
 * also changes TEXT every second while the stopwatch ticks, and fading on each tick
 * would flicker under the reader's eye. So the fade is keyed on the phase, never on
 * the label text.
 */
const MESSAGE = "src/components/chat/message.tsx";

describe("rail label swap", () => {
  const message = readFileSync(MESSAGE, "utf8");
  const group = message.slice(message.indexOf("function ActivityGroup"), message.indexOf("function MemoryNotice"));

  it("fades the label in on a phase change, keyed on the phase", () => {
    expect(group).toMatch(/<span key=\{labelPhase\}[^>]*fade-in/);
  });

  it("the phase does not move with the ticking duration", () => {
    const def = group.match(/const labelPhase = ([^;]+);/);
    expect(def).not.toBeNull();
    expect(def![1]).toMatch(/streaming/);
    expect(def![1]).not.toMatch(/\bms\b|elapsed|label\b/);
  });

  it("the action count fades in when it appears at the end of the turn", () => {
    const count = group.slice(group.indexOf("{countLabel && ("), group.indexOf("</span>", group.indexOf("{countLabel && (")));
    expect(count).toMatch(/fade-in/);
  });
});
