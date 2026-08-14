import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The `manage skill add {repo}` consent hand-off.
 *
 * The card resolves HEAD to a concrete commit, builds the install REVIEW at that commit, and
 * shows it. `add` must then apply exactly that review — same commit and same hash — because
 * native tool approval is two separate calls and nothing but this hand-off connects them.
 *
 * These tests changed shape along with the flow, and the change is the point. The old third
 * case asserted that a missing pin "falls back to live HEAD", which was right while the card
 * was advisory and is fail-OPEN now that the card is the gate: it would apply a plan nobody
 * reviewed, on precisely the request where review matters. A miss must refuse.
 */

const previewSkillRepoInstall = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const applySkillRepoInstall = vi.fn<(...a: unknown[]) => Promise<{ outcome: string }>>(() =>
  Promise.resolve({ outcome: "succeeded" }),
);
vi.mock("@/lib/marketplace/skill-repo", () => ({
  previewSkillRepoInstall: (...a: unknown[]) => previewSkillRepoInstall(...a),
  applySkillRepoInstall: (...a: unknown[]) => applySkillRepoInstall(...a),
  reviewedSkillNames: (r: { surface: { skills: { name: string }[] } }) => r.surface.skills.map((s) => s.name),
  hasLocalEdits: (r: { delta: { effective: { kind: string }[] } }) =>
    r.delta.effective.some((e) => e.kind === "replacement" || e.kind === "unknown"),
  orphanedPolicyKeys: (p: { outlook: string; capabilityKey: string }[]) =>
    p.filter((x) => x.outlook === "applies_to_nothing").map((x) => x.capabilityKey),
}));

vi.mock("@/lib/settings", () => ({
  canInstallExtensions: () => true,
  assertCanInstall: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/skills/service", () => ({
  listManagedSkills: vi.fn(), ingestSkill: vi.fn(), setSkillEnabled: vi.fn(),
  deleteSkill: vi.fn(), getSkillMeta: vi.fn(), getSkillForRun: vi.fn(),
}));
vi.mock("@/lib/sandbox/client", () => ({ uploadFile: vi.fn() }));

import { skillCollection } from "../controls/skills";
import type { ManageContext } from "../types";

const ctx: ManageContext = { userId: "u1", isAdmin: false, projectId: null, sessionKey: "s1" };
const SHA = "f".repeat(40);
const HASH = "a".repeat(64);

/** A review as the card sees it. `delta.effective` drives the overwrite warning; `notes`
 *  carries whatever the plan wants to say (e.g. connectors it did NOT install). */
const review = (over: {
  skills?: string[]; gate?: string; effective?: { kind: string }[]; notes?: string[]; hash?: string;
} = {}) => ({
  review: {
    reviewHash: over.hash ?? HASH,
    gate: over.gate ?? "requires_consent",
    subject: { pluginName: "skills" },
    surface: { skills: (over.skills ?? ["toast"]).map((name) => ({ name })), connectors: [] },
    delta: { effective: over.effective ?? [], upstream: [], kinds: [] },
    notes: over.notes ?? [],
  },
  policies: [] as { outlook: string; capabilityKey: string }[],
  targetSha: SHA,
  marketplaceId: "mk",
});

describe("manage/skills repo install is gated on the card's review", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies the commit AND the hash the card showed", async () => {
    previewSkillRepoInstall.mockResolvedValue(review());
    await skillCollection.previewAdd!(ctx, { repo: "emilkowalski/skills" });
    await skillCollection.add!(ctx, { repo: "emilkowalski/skills" });
    expect(applySkillRepoInstall).toHaveBeenCalledWith(
      expect.objectContaining({ url: "emilkowalski/skills", targetSha: SHA, reviewHash: HASH }));
  });

  it("REFUSES when no card was shown for that repo, instead of installing unreviewed", async () => {
    await expect(skillCollection.add!(ctx, { repo: "owner/never-previewed" }))
      .rejects.toThrow(/reviewed again/);
    expect(applySkillRepoInstall).not.toHaveBeenCalled();
  });

  it("does not cross-wire one repo's review onto another repo's install", async () => {
    previewSkillRepoInstall.mockResolvedValue(review());
    await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    await expect(skillCollection.add!(ctx, { repo: "a/two" })).rejects.toThrow(/reviewed again/);
    expect(applySkillRepoInstall).not.toHaveBeenCalled();
  });

  it("consumes the review, so one card authorizes exactly one install", async () => {
    previewSkillRepoInstall.mockResolvedValue(review());
    await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    await skillCollection.add!(ctx, { repo: "a/one" });
    await expect(skillCollection.add!(ctx, { repo: "a/one" })).rejects.toThrow(/reviewed again/);
    expect(applySkillRepoInstall).toHaveBeenCalledTimes(1);
  });

  it("lists the skills the REVIEW names, which is the set that will land", async () => {
    // The defect this replaces: the card enumerated `skills/*/SKILL.md` while the installer
    // also converted `commands/*.md`, so an approved list was strictly smaller than the
    // installed one. Both now come from the same plan.
    previewSkillRepoInstall.mockResolvedValue(review({ skills: ["csv-tidy", "report"] }));
    const card = await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    expect(card.items).toEqual(["csv-tidy", "report"]);
  });

  it("warns that hand edits will be overwritten", async () => {
    previewSkillRepoInstall.mockResolvedValue(review({ effective: [{ kind: "replacement" }] }));
    const card = await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    expect(card.details).toMatch(/overwrite/i);
  });

  it("says so when the install cannot be applied at all", async () => {
    previewSkillRepoInstall.mockResolvedValue(review({ gate: "cannot_apply" }));
    const card = await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    expect(card.details).toMatch(/can't be installed/i);
  });

  it("surfaces the plan's own notes, including connectors it did not install", async () => {
    previewSkillRepoInstall.mockResolvedValue(review({
      notes: ["2 connector definition(s) in this repo were not installed"],
    }));
    const card = await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    expect(card.details).toMatch(/connector definition/);
  });

  it("turns a stale outcome into its own sentence, not a generic failure", async () => {
    previewSkillRepoInstall.mockResolvedValue(review());
    applySkillRepoInstall.mockResolvedValueOnce({ outcome: "stale" });
    await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    await expect(skillCollection.add!(ctx, { repo: "a/one" })).rejects.toThrow(/changed while you were reading/);
  });

  it("does not report a blocked install as something a retry fixes", async () => {
    previewSkillRepoInstall.mockResolvedValue(review());
    applySkillRepoInstall.mockResolvedValueOnce({ outcome: "blocked" });
    await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    await expect(skillCollection.add!(ctx, { repo: "a/one" })).rejects.toThrow(/unreachable or not allowed/);
  });

  it("says an unfinished install needs attention rather than claiming success", async () => {
    previewSkillRepoInstall.mockResolvedValue(review());
    applySkillRepoInstall.mockResolvedValueOnce({ outcome: "failed" });
    await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    await expect(skillCollection.add!(ctx, { repo: "a/one" })).rejects.toThrow(/needing attention/);
  });
});
