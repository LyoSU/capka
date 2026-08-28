import { describe, it, expect, vi, beforeEach } from "vitest";

const getSkillForRun = vi.fn();
const listAvailableSkills = vi.fn(async () => [] as { name: string }[]);
vi.mock("../service", () => ({
  getSkillForRun: (...a: unknown[]) => getSkillForRun(...a),
  listAvailableSkills: () => listAvailableSkills(),
}));
vi.mock("../materialize", () => ({ materializeSkill: vi.fn() }));

import { makeSkillTool } from "../tool";

const opts = { toolCallId: "1", messages: [] };
const ctx = (effectFor?: (name: string) => "allow" | "ask" | "deny") => ({
  userId: "u1", sessionKey: "s1", projectId: null, effectFor,
});

beforeEach(() => {
  vi.clearAllMocks();
  getSkillForRun.mockResolvedValue({ info: { name: "ocr", body: "do the thing" }, files: [] });
});

describe("makeSkillTool — governance", () => {
  it("suspends only the \"ask\"-governed skill for approval; the rest run as before", async () => {
    const t = makeSkillTool(ctx((n) => (n === "gated" ? "ask" : "allow")));
    const needs = t.needsApproval as (input: unknown, o: unknown) => Promise<boolean>;
    await expect(needs({ name: "gated" }, opts)).resolves.toBe(true);
    await expect(needs({ name: "ocr" }, opts)).resolves.toBe(false);
  });

  it("refuses a \"deny\" skill at execute — the policy gates the call, not just the prompt list", async () => {
    const t = makeSkillTool(ctx(() => "deny"));
    const out = await t.execute!({ name: "ocr" }, opts);
    expect(out).toMatchObject({ error: expect.stringContaining("not available") });
    expect(getSkillForRun).not.toHaveBeenCalled();
  });

  it("without a policy hook, loads the skill exactly as before", async () => {
    const t = makeSkillTool(ctx());
    const needs = t.needsApproval as (input: unknown, o: unknown) => Promise<boolean>;
    await expect(needs({ name: "ocr" }, opts)).resolves.toBe(false);
    const out = await t.execute!({ name: "ocr" }, opts);
    expect(JSON.stringify(out)).toContain("do the thing");
  });
});
