import { describe, it, expect } from "vitest";
import { buildMatcher, isUsable } from "../policy";
import { explainPolicy } from "../matcher";
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

describe("explainPolicy", () => {
  it("returns null when nothing matches (default allow)", () => {
    expect(explainPolicy([], "skill", "anything")).toBeNull();
    expect(explainPolicy([row({ capabilityKey: "notion" })], "connector", "slack")).toBeNull();
  });

  it("returns the matching row's effect, scope and id", () => {
    expect(explainPolicy([row({ id: "p1", scope: "system", effect: "deny" })], "connector", "notion"))
      .toEqual({ effect: "deny", scope: "system", policyId: "p1" });
  });

  it("most-specific scope wins (project > user > system)", () => {
    const rows = [
      row({ id: "s", scope: "system", effect: "deny" }),
      row({ id: "u", scope: "user", effect: "ask" }),
      row({ id: "p", scope: "project", effect: "allow" }),
    ];
    expect(explainPolicy(rows, "connector", "notion")).toEqual({ effect: "allow", scope: "project", policyId: "p" });
    // Drop the project row → user wins over system.
    expect(explainPolicy([rows[0], rows[1]], "connector", "notion")).toEqual({ effect: "ask", scope: "user", policyId: "u" });
  });

  it("a tie within one scope keeps the first row seen", () => {
    const rows = [
      row({ id: "first", scope: "user", effect: "deny" }),
      row({ id: "second", scope: "user", effect: "allow" }),
    ];
    expect(explainPolicy(rows, "connector", "notion")?.policyId).toBe("first");
  });

  it("buildMatcher agrees with explainPolicy's effect", () => {
    const rows = [row({ scope: "system", effect: "deny" }), row({ scope: "project", effect: "allow" })];
    const m = buildMatcher(rows);
    expect(m.effect("connector", "notion")).toBe(explainPolicy(rows, "connector", "notion")?.effect);
    expect(m.effect("skill", "missing")).toBe("allow");
  });
});

describe("isUsable", () => {
  it("usable only when explicitly allowed; ask fails safe (deny) until an approval gate exists", () => {
    expect(isUsable("allow")).toBe(true);
    expect(isUsable("ask")).toBe(false);
    expect(isUsable("deny")).toBe(false);
  });
});
