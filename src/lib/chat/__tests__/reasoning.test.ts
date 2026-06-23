import { describe, it, expect } from "vitest";
import { cleanReasoning } from "../reasoning";

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
