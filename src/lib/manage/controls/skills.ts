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
import {
  applySkillRepoInstall, hasLocalEdits, orphanedPolicyKeys, previewSkillRepoInstall, reviewedSkillNames,
} from "@/lib/marketplace/skill-repo";
import { parseGitHubUrl } from "@/lib/marketplace/source";
import { discoverWorkspaceSkills, ingestWorkspaceSkills } from "@/lib/skills/workspace";
import type { SkillScope } from "@/lib/skills/types";
import { loc, manageT } from "../i18n";
import { claimReviewPin, parkReviewPin, pinIdentity } from "../review-pin";
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

/**
 * preview→apply hand-off for a repo install: the commit AND the review hash the card showed.
 *
 * `previewAdd` resolves HEAD to a concrete commit, builds the install review at that commit
 * and shows it; `add` must apply THAT review — not re-resolve HEAD when the separate approval
 * call runs, and not apply an unreviewed plan.
 *
 * **A miss REFUSES.** It used to fall back to live HEAD, which was defensible while the
 * preview was advisory. It is not defensible now that the card is the consent gate: falling
 * back would apply a plan nobody reviewed, on exactly the request where review matters —
 * the same fail-open shape as the Apply button that installed whenever its review had not
 * loaded. A miss (TTL lapse, a repo never previewed) asks for the card again.
 *
 * Where the pin LIVES, and why it is keyed by the tool call rather than by the repo, is
 * review-pin.ts — the short version is that a per-process map keyed by `userId:repo` lost
 * the pin across a restart and crossed two approvals of one repo.
 */
const identityOf = (a: { repo: string; only?: string[]; scope?: string }) =>
  pinIdentity({ repo: a.repo, scope: skillScope(a).scope, only: a.only });

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
  usage:
    "add args: {content} — one full SKILL.md (frontmatter name+description, then the instruction body); " +
    'OR {repo} — install EVERY skill from a GitHub skills repo ("owner/repo" or a github.com URL); ' +
    "OR {path} — install from the WORKSPACE: a SKILL.md, a skill folder, a repo-shaped folder, or a .zip the user dropped in " +
    "(the server reads the files itself, so PREFER {path} over pasting file contents into {content}). " +
    'add {only:["name",...]} narrows a repo/path/zip to specific skills. ' +
    'To CHANGE an existing skill, call action="edit" (target="skill", itemId): it checks the skill out into the workspace and returns the path — ' +
    "edit the files there with your normal file tools (a small partial edit, NOT re-authoring the whole SKILL.md), then save with add {path}.",
  requiredRole: "user",
  auditNoun: "skill",
  settingsPath: "/settings/skills",
  // Enabling a skill injects its (permanent, agent-visible) instruction back into
  // context, so re-activating a disabled one goes through the human — a
  // prompt-injected agent can't quietly switch on an instruction that steers it.
  confirmEnable: true,
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

    // Repo install: the card is built from the install REVIEW, not from a second enumerator.
    //
    // It used to call `discoverRepoSkills`, which walks `skills/<name>/SKILL.md` — while the
    // installer's `buildPluginPlan` ALSO converts `commands/*.md` into skills (taking the name
    // from the filename, bypassing the frontmatter check). So the card listed what would be
    // installed and the list was incomplete: it asserted something untrue about its own
    // outcome. Keeping two enumerators in step is a promise a comment makes and code does not,
    // so the card now reads the plan that will actually land.
    if ("repo" in a) {
      try {
        const { review, policies, targetSha } = await previewSkillRepoInstall({
          url: a.repo, only: a.only, scope: scope === "system" ? "system" : "user", userId: ctx.userId,
          actor: { userId: ctx.userId, isAdmin: ctx.isAdmin },
        });
        // Pin BOTH: the commit and the hash of the review just shown. `add` refuses without them.
        await parkReviewPin(ctx, identityOf(a), { sha: targetSha, reviewHash: review.reviewHash });
        const names = reviewedSkillNames(review);
        const orphaned = orphanedPolicyKeys(policies);
        // One card, so the lines are ordered by how much they should change the decision:
        // "cannot be applied" first, then an overwrite of somebody's edits, then permissions.
        const lines = [
          review.gate === "cannot_apply"
            ? loc(t, "skill.repoCannotApply", "This can't be installed right now — one of the addresses it needs is unreachable or not allowed.")
            : null,
          hasLocalEdits(review)
            ? loc(t, "skill.repoOverwrites", "Some of these were changed after they were installed. Installing will overwrite those changes.")
            : null,
          orphaned.length
            ? loc(t, "skill.repoOrphanedPolicies", `Permission rules for ${orphaned.join(", ")} will no longer apply to anything. They are kept — remove them in Settings if you want to.`, { names: orphaned.join(", ") })
            : null,
          !names.length ? loc(t, "skill.repoEmpty", "No matching skills found in that repo.") : null,
          ...review.notes,
        ].filter((x): x is string => !!x);
        return {
          title: loc(t, "skill.addRepoTitle", `Install skills from ${review.subject.pluginName}`, { repo: a.repo }),
          after: a.repo,
          items: names,
          details: lines.length ? lines.join(" ") : undefined,
          impact,
        };
      } catch {
        // No review means no consent to obtain, so this card cannot offer to proceed. It used
        // to say "you can still install; it'll pull on confirm" — which was honest while the
        // preview was advisory and is fail-open now that it is the gate.
        return {
          title: loc(t, "skill.addRepoTitle", `Install skills from ${a.repo}`, { repo: a.repo }),
          after: a.repo,
          details: loc(t, "skill.repoUnreachable", "Couldn't read that repo just now, so there is nothing to review — try again in a moment."),
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
      // The card IS the gate, so its review is required — not preferred. Without it there is
      // nothing to apply exactly, and applying approximately is what this whole barrier exists
      // to stop.
      const pinned = await claimReviewPin(ctx, identityOf(a));
      if (!pinned) {
        throw new Error("This install needs to be reviewed again before it can go ahead — ask for it once more and confirm the card that appears.");
      }
      const outcome = await applySkillRepoInstall({
        url: a.repo, only: a.only, scope: scope === "system" ? "system" : "user",
        userId: ctx.userId, actor: { userId: ctx.userId, isAdmin: ctx.isAdmin },
        reviewHash: pinned.reviewHash, targetSha: pinned.sha,
      });
      // Each outcome gets its own sentence: "stale" is not a failure the user caused, and
      // "blocked" is not something a retry fixes.
      if (outcome.outcome === "stale") {
        throw new Error("The repo changed while you were reading — nothing was installed. Ask again to see what it says now.");
      }
      if (outcome.outcome === "blocked") {
        throw new Error("This can't be installed right now: one of the addresses it needs is unreachable or not allowed by the network settings.");
      }
      if (outcome.outcome === "failed" && (outcome.errorCode === "claim_failed" || outcome.errorCode === "audit_failed")) {
        // It never started: the claim itself could not be written, so nothing was installed
        // and nothing is half-applied to go looking for in Settings.
        throw new Error("The install couldn't be started — nothing was changed. Please try again.");
      }
      if (outcome.outcome !== "succeeded") {
        throw new Error("The install didn't finish. It is marked as needing attention in Settings › Skills.");
      }
      const n = (a.only?.length ?? 0) || undefined;
      return {
        itemTitle: n
          ? loc(t, "skill.repoInstalled", `${n} skill${n === 1 ? "" : "s"} from ${a.repo}`, { n, repo: a.repo })
          : loc(t, "skill.repoInstalledAll", `Skills from ${a.repo}`, { repo: a.repo }),
      };
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
