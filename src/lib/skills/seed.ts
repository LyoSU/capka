import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseSkillMarkdown } from "./parse";
import { sanitizeBundlePath } from "./paths";
import { ingestSkill, type IngestTarget } from "./service";

/** Read a skill directory (SKILL.md + sibling files) and ingest it. */
export async function ingestSkillFromDir(dir: string, target: IngestTarget): Promise<string> {
  const raw = await readFile(path.join(dir, "SKILL.md"), "utf8");
  const parsed = parseSkillMarkdown(raw);

  const files: { path: string; content: string }[] = [];
  async function walk(rel: string) {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(relPath);
        continue;
      }
      if (relPath === "SKILL.md") continue;
      const safe = sanitizeBundlePath(relPath);
      if (!safe) continue;
      const buf = await readFile(path.join(dir, relPath));
      files.push({ path: safe, content: buf.toString("base64") });
    }
  }
  await walk("");

  return ingestSkill(parsed, files, target);
}
