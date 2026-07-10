import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the service + sandbox seams `edit` leans on, so the test exercises the
// check-out logic (SKILL.md reconstruction + bundle write-out) with no DB/container.
const getSkillMeta = vi.fn();
const listManagedSkills = vi.fn();
const getSkillForRun = vi.fn();
vi.mock("@/lib/skills/service", () => ({
  getSkillMeta: (...a: unknown[]) => getSkillMeta(...a),
  listManagedSkills: (...a: unknown[]) => listManagedSkills(...a),
  getSkillForRun: (...a: unknown[]) => getSkillForRun(...a),
  ingestSkill: vi.fn(),
  setSkillEnabled: vi.fn(),
  deleteSkill: vi.fn(),
}));
const uploadFile = vi.fn<(...a: unknown[]) => Promise<{ ok: boolean }>>(() => Promise.resolve({ ok: true }));
vi.mock("@/lib/sandbox/client", () => ({ uploadFile: (...a: unknown[]) => uploadFile(...a) }));

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
  it("accepts a workspace path (server reads the file itself)", () => {
    expect(schema.safeParse({ path: "up/skill.zip" }).success).toBe(true);
    expect(schema.safeParse({ path: "packs", only: ["a"] }).success).toBe(true);
    expect(schema.safeParse({ path: "" }).success).toBe(false);
  });
});

describe("manage/skills canAdd", () => {
  it("an admin can always add, regardless of the members toggle", async () => {
    expect(await skillCollection.canAdd!({ isAdmin: true } as ManageContext)).toBe(true);
  });
});

describe("manage/skills edit — check a skill out to the workspace", () => {
  const ctx = { userId: "u1", isAdmin: false, projectId: null, sessionKey: "s1" } as ManageContext;
  beforeEach(() => {
    uploadFile.mockClear();
    getSkillMeta.mockResolvedValue({ id: "sk1", scope: "user", userId: "u1" });
    listManagedSkills.mockResolvedValue([{ id: "sk1", name: "greeter" }]);
    getSkillForRun.mockResolvedValue({
      info: { name: "greeter", description: "says hi", body: "Say hello." },
      files: [{ path: "scripts/run.py", content: Buffer.from("print('hi')").toString("base64") }],
    });
  });

  it("writes a reconstructed SKILL.md plus bundle files under .capka/skills/<name>/", async () => {
    const r = await skillCollection.edit!(ctx, "sk1");
    expect(r.path).toBe(".capka/skills/greeter");
    // SKILL.md written to the skill dir; bundle file to its subdir.
    const dests = uploadFile.mock.calls.map((c) => [c[1], (c[2] as File).name]);
    expect(dests).toContainEqual([".capka/skills/greeter", "SKILL.md"]);
    expect(dests).toContainEqual([".capka/skills/greeter/scripts", "run.py"]);
    const skillMd = uploadFile.mock.calls.find((c) => (c[2] as File).name === "SKILL.md")![2] as File;
    expect(await skillMd.text()).toMatch(/name: greeter[\s\S]*Say hello\./);
  });

  it("refuses without an active workspace", async () => {
    await expect(skillCollection.edit!({ ...ctx, sessionKey: undefined }, "sk1")).rejects.toThrow(/workspace/i);
  });

  it("refuses a skill the caller neither owns nor admins", async () => {
    getSkillMeta.mockResolvedValue({ id: "sk1", scope: "user", userId: "someone-else" });
    await expect(skillCollection.edit!(ctx, "sk1")).rejects.toThrow(/owner or an administrator/i);
  });
});
