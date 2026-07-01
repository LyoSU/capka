import { z } from "zod";
import {
  listManagedSkills,
  ingestSkill,
  setSkillEnabled,
  deleteSkill,
  getSkillMeta,
} from "@/lib/skills/service";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import type { SkillScope } from "@/lib/skills/types";
import type { Collection, ManageContext } from "../types";

const addSchema = z.object({
  content: z
    .string()
    .min(1, "Потрібен вміст SKILL.md (з frontmatter: name, description — і тілом інструкції)."),
  scope: z.enum(["user", "org"]).optional(),
});

type AddArgs = z.infer<typeof addSchema>;

/** A user-scope skill is personal; an org skill is shared and admin-only. */
export function skillScope(args: { scope?: string }): { scope: SkillScope; needsAdmin: boolean } {
  const scope: SkillScope = args.scope === "org" ? "system" : "user";
  return { scope, needsAdmin: scope === "system" };
}

export const skillCollection: Collection = {
  id: "skill",
  title: "Скіли",
  description: "Навички агента — переглянути, додати (SKILL.md), увімкнути/вимкнути, видалити.",
  requiredRole: "user",
  addSchema,

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

  previewAdd(_ctx, args) {
    const a = args as AddArgs;
    let name = "(новий скіл)";
    try {
      name = parseSkillMarkdown(a.content).name;
    } catch { /* previewing invalid markdown — the add will surface the real error */ }
    const { scope } = skillScope(a);
    return {
      title: "Додати скіл",
      after: name,
      impact: scope === "system" ? "Спільний скіл — стане доступним усім користувачам." : undefined,
    };
  },

  async add(ctx, args) {
    const a = args as AddArgs;
    const { scope, needsAdmin } = skillScope(a);
    if (needsAdmin && !ctx.isAdmin) throw new Error("Спільні (org) скіли може додавати лише адміністратор.");
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
  if (!meta) throw new Error("Немає такого скіла.");
  const owned = meta.scope === "user" && meta.userId === ctx.userId;
  if (!owned && !ctx.isAdmin) throw new Error("Керувати цим скілом може лише його власник або адміністратор.");
  // getSkillMeta doesn't return the name; a lightweight list lookup gives a
  // friendly title for the result card (falls back to the id).
  const found = (await listManagedSkills(ctx.userId, true)).find((s) => s.id === itemId);
  return { name: found?.name ?? itemId };
}
