import { and, eq, or, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { skills, skillFiles } from "@/lib/db/schema";
import { mutedIds } from "@/lib/muted-resources";
import { keepRuntimeVisible } from "@/lib/marketplace/runtime-view";
import { FencedWriteError, MANUAL, fencePredicate, insertFenceLock, outcomeOf, type MutationAuthority, type WriteOutcome } from "@/lib/marketplace/fence";
import type { SkillInfo, SkillScope, ParsedSkill } from "./types";

const SCOPE_RANK: Record<SkillScope, number> = { system: 0, user: 1, project: 2 };

function toInfo(row: typeof skills.$inferSelect): SkillInfo {
  return {
    id: row.id,
    scope: row.scope as SkillScope,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    source: row.source,
  };
}

/** Most-specific scope wins on duplicate name (project > user > system). */
export function dedupeByPrecedence(list: SkillInfo[]): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const item of list) {
    const cur = byName.get(item.name);
    if (!cur || SCOPE_RANK[item.scope] > SCOPE_RANK[cur.scope]) byName.set(item.name, item);
  }
  return [...byName.values()];
}

/** Enabled skills visible to this run: system + this user + (if set) this project. */
export async function listAvailableSkills(userId: string, projectId?: string | null): Promise<SkillInfo[]> {
  const scopeFilter = projectId
    ? or(
        eq(skills.scope, "system"),
        and(eq(skills.scope, "user"), eq(skills.userId, userId), isNull(skills.projectId)),
        and(eq(skills.scope, "project"), eq(skills.projectId, projectId)),
      )
    : or(
        eq(skills.scope, "system"),
        and(eq(skills.scope, "user"), eq(skills.userId, userId), isNull(skills.projectId)),
      );

  const rows = await db.select().from(skills).where(and(eq(skills.enabled, true), scopeFilter));
  // Drop shared skills this user has muted for themselves — runtime enforcement
  // of the per-user opt-out (only shared ids are ever muted, so own skills,
  // governed by their own `enabled`, are unaffected).
  const muted = await mutedIds(userId, "skill");
  // Fourth filter (scope → enabled → muted → owner ready), the same one the connector
  // reader applies: a skill belonging to an install that is mid-apply, failed, or gone
  // is not offered to the agent. `getSkillForRun` goes through here, so it inherits it.
  const visible = await keepRuntimeVisible(rows.filter((r) => !muted.has(r.id)));
  return dedupeByPrecedence(visible.map(toInfo));
}

export interface ManagedSkill {
  id: string;
  name: string;
  description: string | null;
  scope: SkillScope;
  source: string;
  /** The caller owns this (a personal, user-scope skill). */
  mine: boolean;
  /** Effective state for this user: own → its own flag; shared → global flag
   *  AND not muted by this user. */
  enabled: boolean;
}

/**
 * Skills for the management UI — unlike the run-time list, this KEEPS items the
 * user has turned off (so they can turn them back on): the caller's own skills
 * in any state, plus shared (system) skills, with their per-user effective
 * state. Globally-disabled shared skills are hidden from regular users (the
 * admin turned them off for everyone) but shown to admins to manage.
 */
export async function listManagedSkills(userId: string, includeDisabledShared: boolean): Promise<ManagedSkill[]> {
  const rows = await db
    .select()
    .from(skills)
    .where(
      or(
        and(eq(skills.scope, "user"), eq(skills.userId, userId), isNull(skills.projectId)),
        eq(skills.scope, "system"),
      ),
    );
  const muted = await mutedIds(userId, "skill");
  const out: ManagedSkill[] = [];
  for (const r of rows) {
    const mine = r.scope === "user";
    if (!mine && !r.enabled && !includeDisabledShared) continue;
    out.push({
      id: r.id,
      name: r.name,
      description: r.description,
      scope: r.scope as SkillScope,
      source: r.source,
      mine,
      enabled: mine ? r.enabled : r.enabled && !muted.has(r.id),
    });
  }
  return out;
}

/** The winning skill by name for this run, with its bundle files. */
export async function getSkillForRun(
  userId: string,
  projectId: string | null | undefined,
  name: string,
): Promise<{ info: SkillInfo; files: { path: string; content: string }[] } | null> {
  const candidates = (await listAvailableSkills(userId, projectId)).filter((x) => x.name === name);
  if (candidates.length === 0) return null;
  const info = candidates[0];
  const files = await db
    .select({ path: skillFiles.path, content: skillFiles.content })
    .from(skillFiles)
    .where(eq(skillFiles.skillId, info.id));
  return { info, files };
}

/** Owner-relevant metadata for one skill, or null if it doesn't exist. */
export async function getSkillMeta(
  id: string,
): Promise<{ id: string; name: string; scope: SkillScope; userId: string | null } | null> {
  const row = (
    await db.select({ id: skills.id, name: skills.name, scope: skills.scope, userId: skills.userId }).from(skills).where(eq(skills.id, id)).limit(1)
  )[0];
  return row ? { id: row.id, name: row.name, scope: row.scope as SkillScope, userId: row.userId } : null;
}

/**
 * Flip a skill's enabled flag, fenced. Authorization (who may ask) is still the caller's
 * responsibility; the fence answers a different question — whether the row may be written
 * AT ALL right now, because its plugin is mid-apply.
 *
 * Returns an outcome, so `missing` and `fenced` stay distinguishable.
 */
export async function setSkillEnabled(id: string, enabled: boolean, authority: MutationAuthority = MANUAL): Promise<WriteOutcome> {
  const res = await db.update(skills).set({ enabled, updatedAt: new Date() })
    .where(and(eq(skills.id, id), fencePredicate(authority, sql`skills.source`)));
  if ((res.rowCount ?? 0) > 0) return "updated";
  const still = await db.select({ id: skills.id }).from(skills).where(eq(skills.id, id)).limit(1);
  return outcomeOf(0, still.length > 0);
}

/** Delete a skill (FK cascade drops its bundle files), fenced. For an idempotent prune
 *  `missing` is a success; `fenced` never is. */
export async function deleteSkill(id: string, authority: MutationAuthority = MANUAL): Promise<WriteOutcome> {
  const res = await db.delete(skills)
    .where(and(eq(skills.id, id), fencePredicate(authority, sql`skills.source`)));
  if ((res.rowCount ?? 0) > 0) return "updated";
  const still = await db.select({ id: skills.id }).from(skills).where(eq(skills.id, id)).limit(1);
  return outcomeOf(0, still.length > 0);
}

export interface IngestTarget {
  scope: SkillScope;
  userId: string | null;
  projectId: string | null;
  source?: string;
  /** Defaults to a manual edit, which is refused while the owning plugin is applying. */
  authority?: MutationAuthority;
}

/** Upsert a parsed skill (+ bundle files) by (scope, owner, name). */
export async function ingestSkill(
  parsed: ParsedSkill,
  files: { path: string; content: string }[],
  target: IngestTarget,
): Promise<string> {
  const existing = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.scope, target.scope),
        target.userId ? eq(skills.userId, target.userId) : isNull(skills.userId),
        target.projectId ? eq(skills.projectId, target.projectId) : isNull(skills.projectId),
        eq(skills.name, parsed.name),
        // Match within the same origin: a plugin (catalog:*) must not overwrite a
        // same-named hand-added skill (and vice versa).
        eq(skills.source, target.source ?? "manual"),
      ),
    )
    .limit(1);

  const id = existing[0]?.id ?? nanoid();
  const values = {
    id,
    scope: target.scope,
    userId: target.userId,
    projectId: target.projectId,
    name: parsed.name,
    description: parsed.description ?? null,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    source: target.source ?? "manual",
    updatedAt: new Date(),
  };

  const authority = target.authority ?? MANUAL;
  // ONE transaction for the row AND its files, holding `insertFenceLock` on the owning
  // install throughout.
  //
  // Splitting them was a real hole: the parent update was fenced, then `skill_files` were
  // written afterwards with no fence at all. A worker that lost its lease between the two
  // could overwrite the support files of a skill someone else had just applied — and those
  // files reach the sandbox. The lock also blocks the reaper and any rival claim for the
  // transaction's whole length, so the lease cannot lapse mid-write.
  return db.transaction(async (tx) => {
    const ok = await tx.execute(insertFenceLock(authority, target.source ?? "manual"));
    if ((ok.rowCount ?? 0) === 0) throw new FencedWriteError(`skill ${parsed.name}`);

    if (existing[0]) {
      const res = await tx.update(skills).set(values)
        .where(and(eq(skills.id, id), fencePredicate(authority, sql`skills.source`)));
      // Throws rather than returning an outcome: the caller asked for the id of a row it was
      // not allowed to write, and there is no honest value for that. The apply path catches
      // it and abandons the operation.
      if ((res.rowCount ?? 0) === 0) throw new FencedWriteError(`skill ${parsed.name}`);
      await tx.delete(skillFiles).where(eq(skillFiles.skillId, id));
    } else {
      await tx.insert(skills).values(values);
    }

    if (files.length) {
      await tx
        .insert(skillFiles)
        .values(files.map((f) => ({ id: nanoid(), skillId: id, path: f.path, content: f.content })));
    }
    return id;
  });
}
