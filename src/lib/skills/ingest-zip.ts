import AdmZip from "adm-zip";
import { parseSkillMarkdown } from "./parse";
import { sanitizeBundlePath } from "./paths";
import { ingestSkill, type IngestTarget } from "./service";
import { SkillParseError } from "./types";

export const MAX_SKILL_ZIP_BYTES = 5 * 1024 * 1024;

export class SkillZipError extends Error {}

/**
 * Parse an uploaded skill .zip (SKILL.md + optional bundle files, allowed nested
 * one level as <skill>/SKILL.md) and ingest it for `target`. Shared by the user
 * and admin upload routes so both validate identically. Throws SkillZipError
 * (bad zip) or SkillParseError (bad SKILL.md) for the route to map to a 400.
 */
export async function ingestSkillZip(
  buffer: Buffer,
  target: IngestTarget,
): Promise<{ id: string; name: string; files: number }> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new SkillZipError("That file isn't a readable .zip.");
  }
  const entries = zip.getEntries();

  const skillEntry = entries.find((e) => !e.isDirectory && /(^|\/)SKILL\.md$/.test(e.entryName));
  if (!skillEntry) throw new SkillZipError("No SKILL.md in zip");
  const basePrefix = skillEntry.entryName.replace(/SKILL\.md$/, "");

  const parsed = parseSkillMarkdown(skillEntry.getData().toString("utf8"));
  if (!parsed.description?.trim()) {
    throw new SkillParseError(
      `Skill "${parsed.name}" has no description. Add a "description:" line to SKILL.md so the assistant knows when to use it.`,
    );
  }

  const files: { path: string; content: string }[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!e.entryName.startsWith(basePrefix)) continue;
    const rel = e.entryName.slice(basePrefix.length);
    const safe = sanitizeBundlePath(rel);
    if (!safe || safe === "SKILL.md") continue;
    files.push({ path: safe, content: e.getData().toString("base64") });
  }

  const id = await ingestSkill(parsed, files, target);
  return { id, name: parsed.name, files: files.length };
}
