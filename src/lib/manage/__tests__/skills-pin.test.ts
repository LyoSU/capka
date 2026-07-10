import { describe, it, expect, vi, beforeEach } from "vitest";

// The repo-install preview resolves the repo's HEAD to a concrete commit and shows
// the user the exact skill set AT that commit. Installing must then pin to THAT
// commit — not re-resolve HEAD when "Approve" runs — or a hostile upstream could
// swap the tree between the card and the click (preview→apply TOCTOU). Native tool
// approval carries no place to stash the sha, so previewAdd parks it for add to
// claim. These tests pin that hand-off at the collection seam (installSkillRepo is
// the boundary; the DB/GitHub plumbing behind it is exercised elsewhere).

const discoverRepoSkills = vi.fn<(url: string) => Promise<unknown>>();
vi.mock("@/lib/marketplace/service", () => ({ discoverRepoSkills: (u: string) => discoverRepoSkills(u) }));

const installSkillRepo = vi.fn<(...a: unknown[]) => Promise<{ skills: unknown[] }>>(() =>
  Promise.resolve({ skills: [{}] }),
);
vi.mock("@/lib/marketplace/install", () => ({ installSkillRepo: (...a: unknown[]) => installSkillRepo(...a) }));

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

describe("manage/skills repo-install commit pinning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("installs the commit the preview showed, not whatever HEAD is at approval time", async () => {
    discoverRepoSkills.mockResolvedValue({ owner: "emilkowalski", repo: "skills", sha: SHA, skills: [{ name: "toast", description: null }] });
    await skillCollection.previewAdd!(ctx, { repo: "emilkowalski/skills" });
    await skillCollection.add!(ctx, { repo: "emilkowalski/skills" });
    expect(installSkillRepo).toHaveBeenCalledWith(expect.objectContaining({ url: "emilkowalski/skills", sha: SHA }));
  });

  it("falls back to live HEAD (no pin) when no preview ran for that repo", async () => {
    await skillCollection.add!(ctx, { repo: "owner/never-previewed" });
    expect(installSkillRepo).toHaveBeenCalledWith(expect.objectContaining({ url: "owner/never-previewed", sha: undefined }));
  });

  it("does not cross-wire one repo's previewed sha onto a different repo's install", async () => {
    discoverRepoSkills.mockResolvedValue({ owner: "a", repo: "one", sha: SHA, skills: [] });
    await skillCollection.previewAdd!(ctx, { repo: "a/one" });
    await skillCollection.add!(ctx, { repo: "a/two" });
    expect(installSkillRepo).toHaveBeenCalledWith(expect.objectContaining({ url: "a/two", sha: undefined }));
  });
});
