import { describe, it, expect } from "vitest";
import { skillScope, skillCollection } from "../controls/skills";
import type { ManageContext } from "../types";

describe("manage/skills skillScope", () => {
  it("defaults to a personal (user) skill needing no admin", () => {
    expect(skillScope({})).toEqual({ scope: "user", needsAdmin: false });
  });
  it("an org skill maps to system and requires admin", () => {
    expect(skillScope({ scope: "org" })).toEqual({ scope: "system", needsAdmin: true });
  });
});

describe("manage/skills addSchema", () => {
  const schema = skillCollection.addSchema!;
  it("requires non-empty SKILL.md content", () => {
    expect(schema.safeParse({ content: "" }).success).toBe(false);
    expect(schema.safeParse({ content: "---\nname: x\n---\nbody" }).success).toBe(true);
  });
});

describe("manage/skills canAdd", () => {
  it("an admin can always add, regardless of the members toggle", async () => {
    expect(await skillCollection.canAdd!({ isAdmin: true } as ManageContext)).toBe(true);
  });
});
