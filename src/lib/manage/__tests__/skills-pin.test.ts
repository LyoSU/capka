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
import type { PendingRecord, PendingStore } from "../pending";
import type { ManageContext } from "../types";

/**
 * The pin lives in the staging table, so the store stands in for it here — and it is shared
 * across the contexts below on purpose: that is what makes "a second process/replica" and
 * "the same user approving twice" expressible at all. A per-process Map could not fail these.
 */
const rows = new Map<string, { rec: PendingRecord; expiresAt: number; consumed: boolean }>();
const store: PendingStore = {
  async stage(rec, ttlMs = 600_000, id) {
    const key = id ?? `gen-${rows.size}`;
    const existing = rows.get(key);
    if (existing && existing.rec.userId !== rec.userId) return key; // owner-scoped upsert
    rows.set(key, { rec, expiresAt: Date.now() + ttlMs, consumed: false });
    return key;
  },
  async consume(id, userId) {
    const r = rows.get(id);
    if (!r || r.consumed || r.rec.userId !== userId || r.expiresAt <= Date.now()) return null;
    r.consumed = true;
    return r.rec;
  },
  async cancel() {},
  async peek() { return "gone"; },
};

const CALL = "call_1";
const at = (toolCallId: string, userId = "u1"): ManageContext =>
  ({ userId, isAdmin: false, projectId: null, sessionKey: "s1", pending: store, toolCallId });
const ctx = at(CALL);
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
  beforeEach(() => { vi.clearAllMocks(); rows.clear(); });

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

  it("keeps two approvals of the SAME repo apart when they differ only in what they install", async () => {
    // The defect this replaces: the pin was keyed by user+repo, so the narrower card's pin
    // overwrote the wider one. Then the FIRST confirm applied the second card's hash — a plan
    // that user had not approved yet — and the second confirm found nothing and refused.
    // Each approval is its own suspended call, so each carries its own pin.
    const all = at("call_all"), one = at("call_one");
    previewSkillRepoInstall.mockResolvedValue(review({ skills: ["toast", "csv-tidy"] }));
    await skillCollection.previewAdd!(all, { repo: "a/one" });
    previewSkillRepoInstall.mockResolvedValue(review({ skills: ["toast"], hash: "b".repeat(64) }));
    await skillCollection.previewAdd!(one, { repo: "a/one", only: ["toast"] });

    await skillCollection.add!(all, { repo: "a/one" });
    expect(applySkillRepoInstall).toHaveBeenLastCalledWith(expect.objectContaining({ reviewHash: HASH }));
    await skillCollection.add!(one, { repo: "a/one", only: ["toast"] });
    expect(applySkillRepoInstall).toHaveBeenLastCalledWith(expect.objectContaining({ reviewHash: "b".repeat(64) }));
  });

  it("refuses a pin spent on arguments the card did not describe", async () => {
    // Same call id, different `only`: the key alone would hand this the wider review, so the
    // identity of what was previewed is checked on the way out too.
    previewSkillRepoInstall.mockResolvedValue(review());
    await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    await expect(skillCollection.add!(ctx, { repo: "a/one", only: ["toast"] })).rejects.toThrow(/reviewed again/);
    expect(applySkillRepoInstall).not.toHaveBeenCalled();
  });

  it("survives the process that showed the card going away", async () => {
    // The pin is durable, so the apply may run in a different process than the preview —
    // a restart between the two, or a second replica taking the approval request.
    previewSkillRepoInstall.mockResolvedValue(review());
    await skillCollection.previewAdd!(at(CALL), { repo: "a/one" });
    await skillCollection.add!(at(CALL), { repo: "a/one" });
    expect(applySkillRepoInstall).toHaveBeenCalledWith(expect.objectContaining({ targetSha: SHA, reviewHash: HASH }));
  });

  it("does not let another user spend a pin by naming its call", async () => {
    previewSkillRepoInstall.mockResolvedValue(review());
    await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    await expect(skillCollection.add!(at(CALL, "u2"), { repo: "a/one" })).rejects.toThrow(/reviewed again/);
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
