import { parseSkillMarkdown } from "@/lib/skills/parse";
import { resolveCommit, ghTree, ghRaw } from "./fetch";
import type { CommitInfo, GitHubRef } from "./types";

/** A skill found in a repo, for the pre-install preview — name + description from
 *  its SKILL.md frontmatter (what the user approves before installing). */
export interface DiscoveredSkill { name: string; description: string | null }

/**
 * Enumerate the skills a git repo would install, WITHOUT installing — the dry-run
 * behind the "add a whole skills repo" confirm (mirrors `npx skills add … --list`).
 * Reads `<subdir>/skills/<name>/SKILL.md` (the same shape `applyPlugin` ingests, so
 * the preview can't list a skill the install would skip) at a pinned commit, and
 * parses each frontmatter. Malformed SKILL.md files are skipped, not fatal.
 */
export async function discoverSkills(
  gh: GitHubRef,
  fetchFn: typeof fetch,
): Promise<{ commit: CommitInfo; skills: DiscoveredSkill[] }> {
  const prefix = gh.subdir ? `${gh.subdir}/` : "";
  const commit = await resolveCommit(gh.owner, gh.repo, gh.ref, fetchFn);
  const tree = await ghTree(gh.owner, gh.repo, commit.sha, fetchFn);
  const skillMds = tree
    .filter((t) => t.type === "blob" && t.path.startsWith(`${prefix}skills/`) && t.path.endsWith("/SKILL.md"))
    .sort((a, b) => a.path.localeCompare(b.path));

  const skills: DiscoveredSkill[] = [];
  for (const md of skillMds) {
    const body = await ghRaw(gh.owner, gh.repo, commit.sha, md.path, fetchFn);
    if (!body) continue;
    try {
      const parsed = parseSkillMarkdown(body);
      if (parsed.name) skills.push({ name: parsed.name, description: parsed.description ?? null });
    } catch { /* invalid SKILL.md — skip, matching the installer */ }
  }
  return { commit, skills };
}
