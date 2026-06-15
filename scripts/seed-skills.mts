/**
 * Dev seed: import the repo's on-disk .claude/skills/* as SYSTEM skills.
 * Usage: npx tsx scripts/seed-skills.mts
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ingestSkillFromDir } from "../src/lib/skills/seed";

const root = path.resolve(".claude/skills");
const dirs = await readdir(root, { withFileTypes: true });
for (const d of dirs) {
  if (!d.isDirectory()) continue;
  const id = await ingestSkillFromDir(path.join(root, d.name), {
    scope: "system",
    userId: null,
    projectId: null,
    source: "manual",
  });
  console.log(`seeded ${d.name} -> ${id}`);
}
process.exit(0);
