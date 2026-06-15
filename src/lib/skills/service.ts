import { and, eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { skills, skillFiles } from "@/lib/db/schema";
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
  return dedupeByPrecedence(rows.map(toInfo));
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
