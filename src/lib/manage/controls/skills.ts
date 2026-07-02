import { z } from "zod";
import matter from "gray-matter";
import {
  listManagedSkills,
  ingestSkill,
  setSkillEnabled,
  deleteSkill,
  getSkillMeta,
  getSkillForRun,
} from "@/lib/skills/service";
import { uploadFile } from "@/lib/sandbox/client";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import { canInstallExtensions, assertCanInstall } from "@/lib/settings";
import { discoverRepoSkills } from "@/lib/marketplace/service";
import { installSkillRepo } from "@/lib/marketplace/install";
import { parseGitHubUrl } from "@/lib/marketplace/source";
import { discoverWorkspaceSkills, ingestWorkspaceSkills } from "@/lib/skills/workspace";
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
  z.object({
    path: z.string().min(1, "A workspace path is required — a SKILL.md, a skill folder, a repo-shaped folder, or a .zip."),
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
    else if ("path" in a) { if (!ctx.sessionKey) throw new Error("No active workspace — open a chat with the sandbox to install a skill from a file."); }
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

    // Workspace path: enumerate the skills the pointed-at file/folder/zip holds,
    // read server-side (0 model tokens), so the user approves the actual set.
    if ("path" in a) {
      try {
        const only = a.only?.length ? new Set(a.only) : null;
        const all = await discoverWorkspaceSkills(ctx.sessionKey!, ctx.userId, a.path, a.only);
        const names = only ? all.filter((n) => only.has(n)) : all;
        return {
          title: loc(t, "skill.addPathTitle", `Install skills from ${a.path}`, { path: a.path }),
          after: a.path,
          items: names,
          details: names.length ? undefined : loc(t, "skill.pathEmpty", "No SKILL.md found at that path."),
          impact,
        };
      } catch {
        return {
          title: loc(t, "skill.addPathTitle", `Install skills from ${a.path}`, { path: a.path }),
          after: a.path,
          details: loc(t, "skill.pathUnreachable", "Couldn't read that path just now — you can still install; it'll be read on confirm."),
          impact,
        };
      }
    }

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

    if ("path" in a) {
      const names = await ingestWorkspaceSkills({
        sessionKey: ctx.sessionKey!,
        userId: ctx.userId,
        path: a.path,
        target: { scope, userId: scope === "user" ? ctx.userId : null, projectId: null },
        only: a.only,
      });
      const n = names.length;
      return { itemTitle: loc(t, "skill.pathInstalled", `${n} skill${n === 1 ? "" : "s"} from ${a.path}`, { n, path: a.path }) };
    }

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

  // Check a skill OUT into the workspace so the agent edits it with its normal
  // file tools (a cheap partial edit) instead of re-authoring the whole SKILL.md
  // through a tool argument. The save-back is `add {path}`, which upserts by name.
  async edit(ctx, itemId) {
    const t = manageT(ctx.locale);
    if (!ctx.sessionKey) throw new Error("No active workspace to edit the skill in.");
    const s = await mustManageSkill(ctx, itemId); // authorizes (own / admin) + resolves name
    const run = await getSkillForRun(ctx.userId, ctx.projectId, s.name);
    if (!run) throw new Error("No such skill.");
    const dir = `.capka/skills/${s.name}`;
    // Reconstruct SKILL.md from the stored name+description+body (the load-bearing
    // frontmatter). Re-ingest on save re-parses whatever the agent writes.
    const md = matter.stringify(run.info.body, { name: run.info.name, description: run.info.description ?? undefined });
    await uploadFile(ctx.sessionKey, dir, new File([md], "SKILL.md"), ctx.userId);
    for (const f of run.files) {
      const slash = f.path.lastIndexOf("/");
      const sub = slash >= 0 ? `${dir}/${f.path.slice(0, slash)}` : dir;
      await uploadFile(ctx.sessionKey, sub, new File([Buffer.from(f.content, "base64")], slash >= 0 ? f.path.slice(slash + 1) : f.path), ctx.userId);
    }
    return {
      itemTitle: s.name,
      path: dir,
      instruction: loc(t, "skill.editReady", `"${s.name}" is checked out to ${dir}/SKILL.md — edit the files there, then save with skill add {path:"${dir}"}.`, { name: s.name, path: dir }),
    };
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
