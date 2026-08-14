import { describe, it, expect, vi } from "vitest";

/**
 * Which rows the Skills Library is served, which is where the defect lived: the route filtered
 * every `catalog:` row, so a skill whose owning install had vanished was hidden here, hidden
 * from every run by `keepRuntimeVisible`, and had no Extensions row left to be managed from.
 *
 * Asserted at the ROUTE and not on `keepManageable`, because the rule being tested is that the
 * route delegates to it. A test of the helper alone passed happily while the route kept its own
 * `startsWith("catalog:")`.
 */
const h = vi.hoisted(() => ({
  /** `plugin_installs` rows `ownerStates` will find. Empty = every catalog row is an orphan. */
  installs: [] as { id: string; status: string | null }[],
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireSession: () => Promise.resolve({ userId: "u1", role: "admin" as const, status: "active" as const }),
  };
});
vi.mock("@/lib/skills/service", () => ({
  listManagedSkills: () => Promise.resolve(h.rows),
  getSkillMeta: () => Promise.resolve(null),
  deleteSkill: () => Promise.resolve(),
  setSkillEnabled: () => Promise.resolve(),
}));
// `ownerStates` reads the owning installs through the raw pool; nothing else here touches it.
vi.mock("@/lib/db", () => ({ pool: { query: () => Promise.resolve({ rows: h.installs }) } }));

import { GET } from "../route";

const skill = (over: Record<string, unknown>) => ({
  id: "s1", name: "writer", description: "d", scope: "system", enabled: true, mine: false,
  source: "manual", ...over,
});

// The handler takes no request — the listing is entirely a function of the session.
const listed = async () => {
  const body = await (await GET()).json() as {
    skills: { id: string; orphaned: boolean }[];
  };
  return body.skills;
};

describe("GET /api/skills", () => {
  it("shows a hand-added skill, marked not-orphaned", async () => {
    h.installs = [];
    h.rows = [skill({})];
    expect(await listed()).toEqual([expect.objectContaining({ id: "s1", orphaned: false })]);
  });

  it("hides a live plugin's skill — the Extensions tab manages it as part of the plugin", async () => {
    h.installs = [{ id: "i1", status: null }];
    h.rows = [skill({ id: "s2", source: "catalog:i1" })];
    expect(await listed()).toEqual([]);
  });

  it("hides a plugin's skill mid-apply too, rather than showing it half-updated", async () => {
    h.installs = [{ id: "i1", status: "applying" }];
    h.rows = [skill({ id: "s2", source: "catalog:i1" })];
    expect(await listed()).toEqual([]);
  });

  it("SHOWS an orphan, flagged, so the one row nothing else can reach can be deleted", async () => {
    h.installs = []; // the owning install is gone
    h.rows = [skill({ id: "s3", source: "catalog:i-gone" })];
    expect(await listed()).toEqual([expect.objectContaining({ id: "s3", orphaned: true })]);
  });

  it("never leaks `source` to the client", async () => {
    // The Library has no use for it, and it names an internal install id.
    h.installs = [];
    h.rows = [skill({})];
    expect((await listed())[0]).not.toHaveProperty("source");
  });
});
