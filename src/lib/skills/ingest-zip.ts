import AdmZip from "adm-zip";
import { parseSkillMarkdown } from "./parse";
import { sanitizeBundlePath } from "./paths";
import { ingestSkill, type IngestTarget } from "./service";
import { SkillParseError } from "./types";

export const MAX_SKILL_ZIP_BYTES = 5 * 1024 * 1024;
// Decompression-bomb guards: the 5 MB compressed cap above says nothing about the
// UNCOMPRESSED size, and a zip-bomb can expand to gigabytes. Bound entry count,
// per-entry size, and total uncompressed bytes before reading any entry data.
const MAX_ZIP_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

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

  // Reject decompression bombs up front, using the zip's declared sizes — before
  // any getData() allocates the uncompressed bytes into memory.
  if (entries.length > MAX_ZIP_ENTRIES) throw new SkillZipError("That zip has too many files.");
  let totalUncompressed = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (e.header.size > MAX_ENTRY_BYTES) throw new SkillZipError("A file inside the zip is too large.");
    totalUncompressed += e.header.size;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new SkillZipError("The zip's contents are too large.");
  }

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
