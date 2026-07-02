import { z } from "zod";
import {
  listManagedSkills,
  ingestSkill,
  setSkillEnabled,
  deleteSkill,
  getSkillMeta,
} from "@/lib/skills/service";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import { canInstallExtensions, assertCanInstall } from "@/lib/settings";
import { discoverRepoSkills } from "@/lib/marketplace/service";
import { installSkillRepo } from "@/lib/marketplace/install";
import { parseGitHubUrl } from "@/lib/marketplace/source";
import type { SkillScope } from "@/lib/skills/types";
import { loc, manageT } from "../i18n";
import type { Collection, ManageContext } from "../types";

// Add a skill EITHER inline (one SKILL.md) OR from a whole GitHub repo (install
// every skill under skills/<name>/, à la `npx skills add owner/repo`; `only`
// narrows to specific ones). `repo` accepts a github.com URL or `owner/repo`.
const addSchema = z.union([
  z.object({
    content: z.string().min(1, "SKILL.md content is required (frontmatter: name, description — plus the instruction body)."),
    scope: z.enum(["user", "org"]).optional(),
  }),
  z.object({
    repo: z.string().min(1, "A GitHub repo is required — a github.com URL or owner/repo (e.g. publora/skills)."),
    only: z.array(z.string()).optional(),
    scope: z.enum(["user", "org"]).optional(),
  }),
]);

type AddArgs = z.infer<typeof addSchema>;

/** A user-scope skill is personal; an org skill is shared and admin-only. */
export function skillScope(args: { scope?: string }): { scope: SkillScope; needsAdmin: boolean } {
  const scope: SkillScope = args.scope === "org" ? "system" : "user";
  return { scope, needsAdmin: scope === "system" };
}

/** Authorization for adding a skill, shared by the dispatcher's confirm-phase
 *  pre-flight (`validateAdd`) and the apply-phase (`add`). */
async function assertCanAddSkill(ctx: ManageContext, a: { scope?: string }): Promise<void> {
  const { needsAdmin } = skillScope(a);
  if (needsAdmin && !ctx.isAdmin) throw new Error("Shared (org) skills can only be added by an administrator.");
  await assertCanInstall(ctx.isAdmin, "skill");
}

export const skillCollection: Collection = {
  id: "skill",
  title: "Skills",
  description: "Agent skills — list, add (SKILL.md), enable/disable, remove.",
  requiredRole: "user",
  auditNoun: "skill",
  settingsPath: "/settings/skills",
  addSchema,

  canAdd: (ctx) => canInstallExtensions(ctx.isAdmin),

  async validateAdd(ctx, args) {
    const a = args as AddArgs;
    await assertCanAddSkill(ctx, a);
    // Fail up front (before a card): a single skill's markdown must parse; a repo
    // must at least look like a GitHub reference. The repo's real content is read
    // in previewAdd (which lists the skills it would install).
    if ("content" in a) parseSkillMarkdown(a.content);
    else if (!parseGitHubUrl(a.repo)) throw new Error("That doesn't look like a GitHub repo — use a github.com URL or owner/repo (e.g. publora/skills).");
  },

  async list(ctx) {
    const skills = await listManagedSkills(ctx.userId, ctx.isAdmin);
    return skills.map((s) => ({
      id: s.id,
      title: s.name,
      subtitle: s.description ?? undefined,
      enabled: s.enabled,
      owned: s.mine,
    }));
  },

  async previewAdd(ctx, args) {
    const t = manageT(ctx.locale);
    const a = args as AddArgs;
    const { scope } = skillScope(a);
    const impact = scope === "system" ? loc(t, "skill.sharedImpact", "Shared skill — available to all users.") : undefined;

    // Repo install: enumerate the skills it would install so the user approves the
    // whole SET before confirming (like `npx skills add owner/repo --list`).
    if ("repo" in a) {
      try {
        const { owner, repo, skills } = await discoverRepoSkills(a.repo);
        const only = a.only?.length ? new Set(a.only) : null;
        const names = (only ? skills.filter((s) => only.has(s.name)) : skills).map((s) => s.name);
        return {
          title: loc(t, "skill.addRepoTitle", `Install skills from ${owner}/${repo}`, { repo: `${owner}/${repo}` }),
          after: `${owner}/${repo}`,
          items: names,
          details: names.length ? undefined : loc(t, "skill.repoEmpty", "No matching skills found in that repo."),
          impact,
        };
      } catch {
        // Advisory probe — a read failure must never block the add.
        return {
          title: loc(t, "skill.addRepoTitle", `Install skills from ${a.repo}`, { repo: a.repo }),
          after: a.repo,
          details: loc(t, "skill.repoUnreachable", "Couldn't read the repo just now — you can still install; it'll pull on confirm."),
          impact,
        };
      }
    }

    // Single inline skill — the user approves a PERMANENT instruction the agent
    // wrote, so show what it does (description) + the full SKILL.md collapsibly.
    let name = loc(t, "skill.newSkill", "(new skill)");
    let details: string | undefined;
    try {
      const parsed = parseSkillMarkdown(a.content);
      name = parsed.name;
      details = parsed.description ?? undefined;
    } catch { /* previewing invalid markdown — the add will surface the real error */ }
    return { title: loc(t, "skill.addTitle", "Add skill"), after: name, details, body: a.content, impact };
  },

  async add(ctx, args) {
    const t = manageT(ctx.locale);
    const a = args as AddArgs;
    await assertCanAddSkill(ctx, a); // defense-in-depth: dispatch pre-flights this too
    const { scope } = skillScope(a);

    if ("repo" in a) {
      const manifest = await installSkillRepo({
        url: a.repo,
        installedBy: ctx.userId,
        scope: scope === "system" ? "system" : "user",
        only: a.only,
      });
      const n = manifest.skills.length;
      return { itemTitle: loc(t, "skill.repoInstalled", `${n} skill${n === 1 ? "" : "s"} from ${a.repo}`, { n, repo: a.repo }) };
    }

    const parsed = parseSkillMarkdown(a.content); // throws SkillParseError → surfaced as a friendly error
    await ingestSkill(parsed, [], { scope, userId: scope === "user" ? ctx.userId : null, projectId: null });
    return { itemTitle: parsed.name };
  },

  async remove(ctx, itemId) {
    const s = await mustManageSkill(ctx, itemId);
    await deleteSkill(itemId);
    return { itemTitle: s.name };
  },

  async setEnabled(ctx, itemId, enabled) {
    const s = await mustManageSkill(ctx, itemId);
    await setSkillEnabled(itemId, enabled);
    return { itemTitle: s.name };
  },
};

/** Ensure the caller may mutate this skill: own a personal one, or be an admin
 *  for a shared one. Returns a minimal descriptor (name for the result). */
async function mustManageSkill(ctx: ManageContext, itemId: string): Promise<{ name: string }> {
  const meta = await getSkillMeta(itemId);
  if (!meta) throw new Error("No such skill.");
  const owned = meta.scope === "user" && meta.userId === ctx.userId;
  if (!owned && !ctx.isAdmin) throw new Error("Only the owner or an administrator can manage this skill.");
  const found = (await listManagedSkills(ctx.userId, true)).find((s) => s.id === itemId);
  return { name: found?.name ?? itemId };
}
