import { inflateRawSync } from "node:zlib";
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

// ZIP compression methods we accept (PKWARE APPNOTE 4.4.5).
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

export class SkillZipError extends Error {}

/**
 * Read one entry's bytes with a HARD output cap. The pre-scan above trusts each
 * entry's *declared* size, but `getData()` inflates the actual stream — a crafted
 * zip can understate the header and still expand to gigabytes in memory. So we
 * inflate via Node's zlib with `maxOutputLength`, which throws the moment output
 * exceeds the cap (a platform-native bomb guard), instead of trusting the header.
 */
function readEntry(e: AdmZip.IZipEntry, cap: number): Buffer {
  if (e.header.method === METHOD_STORED) {
    // Not compressed: bytes are bounded by the 5 MB compressed-zip cap already.
    const data = e.getData();
    if (data.length > cap) throw new SkillZipError("A file inside the zip is too large.");
    return data;
  }
  if (e.header.method !== METHOD_DEFLATED) throw new SkillZipError("That zip uses an unsupported compression method.");
  try {
    return inflateRawSync(e.getCompressedData(), { maxOutputLength: cap });
  } catch {
    // RangeError from exceeding maxOutputLength, or a corrupt deflate stream.
    throw new SkillZipError("A file inside the zip is too large or corrupt.");
  }
}

/**
 * Parse a skill .zip (SKILL.md + optional bundle files, allowed nested one level
 * as <skill>/SKILL.md) into a ready-to-ingest skill WITHOUT touching the DB.
 * Applies every decompression-bomb guard. Shared by the upload routes and by
 * workspace-path ingestion so a preview and an install validate identically.
 * Throws SkillZipError (bad zip) or SkillParseError (bad SKILL.md).
 */
export function readSkillZip(buffer: Buffer): {
  parsed: ReturnType<typeof parseSkillMarkdown>;
  files: { path: string; content: string }[];
} {
  // Hard compressed-size cap at the true entry point. The upload routes check
  // `file.size` before buffering, but the workspace-install path buffers a
  // controller download that has no such gate — so enforce it here too, the one
  // place every caller (upload AND workspace) funnels through, before AdmZip
  // parses anything.
  if (buffer.length > MAX_SKILL_ZIP_BYTES) throw new SkillZipError("That zip is too large.");

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

  const parsed = parseSkillMarkdown(readEntry(skillEntry, MAX_ENTRY_BYTES).toString("utf8"));
  if (!parsed.description?.trim()) {
    throw new SkillParseError(
      `Skill "${parsed.name}" has no description. Add a "description:" line to SKILL.md so the assistant knows when to use it.`,
    );
  }

  const files: { path: string; content: string }[] = [];
  let readBytes = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!e.entryName.startsWith(basePrefix)) continue;
    const rel = e.entryName.slice(basePrefix.length);
    const safe = sanitizeBundlePath(rel);
    if (!safe || safe === "SKILL.md") continue;
    const data = readEntry(e, MAX_ENTRY_BYTES);
    // Enforce the total on ACTUAL inflated bytes, not just the declared sizes.
    readBytes += data.length;
    if (readBytes > MAX_UNCOMPRESSED_BYTES) throw new SkillZipError("The zip's contents are too large.");
    files.push({ path: safe, content: data.toString("base64") });
  }
  return { parsed, files };
}

/**
 * Parse an uploaded skill .zip and ingest it for `target`. Shared by the user and
 * admin upload routes so both validate identically.
 */
export async function ingestSkillZip(
  buffer: Buffer,
  target: IngestTarget,
): Promise<{ id: string; name: string; files: number }> {
  const { parsed, files } = readSkillZip(buffer);
  const id = await ingestSkill(parsed, files, target);
  return { id, name: parsed.name, files: files.length };
}
