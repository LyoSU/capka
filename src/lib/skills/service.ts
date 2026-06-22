import { and, eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { skills, skillFiles } from "@/lib/db/schema";
import { mutedIds } from "@/lib/muted-resources";
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
  return dedupeByPrecedence(rows.filter((r) => !muted.has(r.id)).map(toInfo));
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
): Promise<{ id: string; scope: SkillScope; userId: string | null } | null> {
  const row = (
    await db.select({ id: skills.id, scope: skills.scope, userId: skills.userId }).from(skills).where(eq(skills.id, id)).limit(1)
  )[0];
  return row ? { id: row.id, scope: row.scope as SkillScope, userId: row.userId } : null;
}

/** Flip a skill's enabled flag. Authorization is the caller's responsibility. */
export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(skills).set({ enabled, updatedAt: new Date() }).where(eq(skills.id, id));
}

/** Delete a skill (FK cascade drops its bundle files). Authorization is the caller's. */
export async function deleteSkill(id: string): Promise<void> {
  await db.delete(skills).where(eq(skills.id, id));
}

export interface IngestTarget {
  scope: SkillScope;
  userId: string | null;
  projectId: string | null;
  source?: string;
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

  if (existing[0]) {
    await db.update(skills).set(values).where(eq(skills.id, id));
    await db.delete(skillFiles).where(eq(skillFiles.skillId, id));
  } else {
    await db.insert(skills).values(values);
  }

  if (files.length) {
    await db
      .insert(skillFiles)
      .values(files.map((f) => ({ id: nanoid(), skillId: id, path: f.path, content: f.content })));
  }
  return id;
}
