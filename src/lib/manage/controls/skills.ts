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
import type { SkillScope } from "@/lib/skills/types";
import { loc, manageT } from "../i18n";
import type { Collection, ManageContext } from "../types";

const addSchema = z.object({
  content: z.string().min(1, "SKILL.md content is required (frontmatter: name, description — plus the instruction body)."),
  scope: z.enum(["user", "org"]).optional(),
});

type AddArgs = z.infer<typeof addSchema>;

/** A user-scope skill is personal; an org skill is shared and admin-only. */
export function skillScope(args: { scope?: string }): { scope: SkillScope; needsAdmin: boolean } {
  const scope: SkillScope = args.scope === "org" ? "system" : "user";
  return { scope, needsAdmin: scope === "system" };
}

/** Authorization for adding a skill, shared by the dispatcher's confirm-phase
 *  pre-flight (`validateAdd`) and the apply-phase (`add`). */
async function assertCanAddSkill(ctx: ManageContext, a: AddArgs): Promise<void> {
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
    parseSkillMarkdown(a.content); // throws SkillParseError (friendly) BEFORE a card is shown
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

  previewAdd(ctx, args) {
    const t = manageT(ctx.locale);
    const a = args as AddArgs;
    let name = loc(t, "skill.newSkill", "(new skill)");
    let details: string | undefined;
    try {
      const parsed = parseSkillMarkdown(a.content);
      name = parsed.name;
      details = parsed.description ?? undefined;
    } catch { /* previewing invalid markdown — the add will surface the real error */ }
    const { scope } = skillScope(a);
    return {
      title: loc(t, "skill.addTitle", "Add skill"),
      after: name,
      // The user is approving a PERMANENT instruction the agent wrote — show what
      // it does (description) and the full SKILL.md, so it's never confirmed blind.
      details,
      body: a.content,
      impact: scope === "system" ? loc(t, "skill.sharedImpact", "Shared skill — available to all users.") : undefined,
    };
  },

  async add(ctx, args) {
    const a = args as AddArgs;
    await assertCanAddSkill(ctx, a); // defense-in-depth: dispatch pre-flights this too
    const { scope } = skillScope(a);
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
