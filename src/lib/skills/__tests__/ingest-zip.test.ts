import { describe, it, expect, vi, beforeEach } from "vitest";
import AdmZip from "adm-zip";

// Capture what would be persisted without touching the DB.
const ingestSkill = vi.fn().mockResolvedValue("skill_123");
vi.mock("../service", () => ({ ingestSkill: (...args: unknown[]) => ingestSkill(...args) }));

import { ingestSkillZip, readSkillZip, SkillZipError, MAX_SKILL_ZIP_BYTES } from "../ingest-zip";

const SKILL_MD = "---\nname: my-skill\ndescription: Does a thing.\n---\n# Body\n";
const target = { scope: "system" as const, userId: null, projectId: null };

function zipOf(files: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  return z.toBuffer();
}

const persistedFiles = () => ingestSkill.mock.calls[0][1] as { path: string; content: string }[];

describe("ingestSkillZip", () => {
  beforeEach(() => ingestSkill.mockClear());

  it("extracts SKILL.md and its bundle files (excluding SKILL.md itself)", async () => {
    const res = await ingestSkillZip(zipOf({ "SKILL.md": SKILL_MD, "ref/data.txt": "hello" }), target);
    expect(res.name).toBe("my-skill");
    const files = persistedFiles();
    expect(files.map((f) => f.path)).toEqual(["ref/data.txt"]);
    expect(Buffer.from(files[0].content, "base64").toString()).toBe("hello");
  });

  it("drops entries whose path escapes the bundle (traversal / absolute)", async () => {
    await ingestSkillZip(zipOf({ "SKILL.md": SKILL_MD, "../evil.txt": "x", "/abs.txt": "y" }), target);
    // sanitizeBundlePath rejects '..' and leading '/', so nothing escapes.
    expect(persistedFiles().every((f) => !f.path.includes("..") && !f.path.startsWith("/"))).toBe(true);
  });

  it("rejects a zip with no SKILL.md", async () => {
    await expect(ingestSkillZip(zipOf({ "readme.txt": "x" }), target)).rejects.toThrow(SkillZipError);
    expect(ingestSkill).not.toHaveBeenCalled();
  });

  it("rejects an unreadable (non-zip) buffer", async () => {
    await expect(ingestSkillZip(Buffer.from("not a zip"), target)).rejects.toThrow(SkillZipError);
  });

  it("rejects a buffer larger than the compressed cap BEFORE parsing (the shared entry-point gate)", () => {
    // A buffer just over the cap — readSkillZip must refuse it up front, so the
    // workspace-install path (which buffers a controller download) can't force the
    // platform to AdmZip-parse an oversized archive.
    const tooBig = Buffer.alloc(MAX_SKILL_ZIP_BYTES + 1);
    expect(() => readSkillZip(tooBig)).toThrow(SkillZipError);
    expect(ingestSkill).not.toHaveBeenCalled();
  });
});
