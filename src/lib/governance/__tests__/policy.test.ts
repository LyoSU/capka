import { describe, it, expect } from "vitest";
import { buildMatcher, isUsable } from "../policy";
import type { PolicyRow } from "../types";

const row = (o: Partial<PolicyRow>): PolicyRow => ({
  scope: "system", capabilityType: "connector", capabilityKey: "notion", effect: "deny", ...o,
});

describe("buildMatcher", () => {
  it("defaults to allow when no policy matches", () => {
    const m = buildMatcher([]);
    expect(m.effect("skill", "anything")).toBe("allow");
  });

  it("applies a matching policy", () => {
    const m = buildMatcher([row({ effect: "deny" })]);
    expect(m.effect("connector", "notion")).toBe("deny");
    expect(m.effect("connector", "other")).toBe("allow");
  });

  it("most-specific scope wins (project > user > system)", () => {
    const m = buildMatcher([
      row({ scope: "system", effect: "deny" }),
      row({ scope: "project", effect: "allow" }),
    ]);
    expect(m.effect("connector", "notion")).toBe("allow");
  });
});

describe("isUsable", () => {
  it("usable only when explicitly allowed; ask fails safe (deny) until an approval gate exists", () => {
    expect(isUsable("allow")).toBe(true);
    expect(isUsable("ask")).toBe(false);
    expect(isUsable("deny")).toBe(false);
  });
});
