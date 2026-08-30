import { describe, it, expect } from "vitest";
import { cleanReasoning, hasVisibleReasoning } from "../reasoning";

describe("cleanReasoning", () => {
  it("drops a leading wrapper tag and the blank lines after it", () => {
    expect(cleanReasoning("<thinking>\n\nThe user asked X.")).toBe("The user asked X.");
  });

  it("strips the wrapper tags but keeps the thought between them", () => {
    expect(cleanReasoning("<think>Let me check.</think>")).toBe("Let me check.");
  });

  it("handles tags with attributes", () => {
    expect(cleanReasoning('<reasoning effort="high">Plan it.')).toBe("Plan it.");
  });

  it("trims an extra leading break and trailing whitespace", () => {
    expect(cleanReasoning("\n  First, I'll…  \n")).toBe("First, I'll…");
  });

  it("collapses runs of blank lines left inside the thought", () => {
    expect(cleanReasoning("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("leaves real angle-bracket content alone", () => {
    expect(cleanReasoning("compare a < b and <div> in the code")).toBe("compare a < b and <div> in the code");
  });

  it("is a no-op on empty input", () => {
    expect(cleanReasoning("")).toBe("");
  });
});

/** The guard that decides whether a thought gets a row on the step rail. It has
 *  to agree with what `ReasoningRow` will actually paint, because the two used
 *  to disagree: the rail asked `if (text)` on the RAW string while the row ran
 *  `cleanReasoning` first, so a part carrying nothing but a line break opened a
 *  lightbulb node with no text beside it. Both `"\n"` and `"\n\n"` are shapes
 *  taken verbatim from stored turns. */
describe("hasReasoning", () => {
  it("rejects the bare line breaks models emit between tool calls", () => {
    expect(hasVisibleReasoning("\n")).toBe(false);
    expect(hasVisibleReasoning("\n\n")).toBe(false);
  });

  it("rejects a part that is only a chain-of-thought wrapper", () => {
    expect(hasVisibleReasoning("<think></think>")).toBe(false);
    expect(hasVisibleReasoning("<thinking>\n\n</thinking>")).toBe(false);
  });

  it("rejects nothing at all", () => {
    expect(hasVisibleReasoning("")).toBe(false);
    expect(hasVisibleReasoning(undefined)).toBe(false);
    expect(hasVisibleReasoning(null)).toBe(false);
  });

  it("accepts a real thought, however short", () => {
    expect(hasVisibleReasoning("Ok.")).toBe(true);
    expect(hasVisibleReasoning("\n  Let me check.  \n")).toBe(true);
  });

  it("answers false exactly when the row would render empty", () => {
    for (const raw of ["\n", "\n\n", "   ", "<think>\n</think>", "Ok.", "a\n\nb"]) {
      expect(hasVisibleReasoning(raw)).toBe(cleanReasoning(raw) !== "");
    }
  });
});
