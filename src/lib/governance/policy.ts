import { and, eq, or, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { capabilityPolicies, skills, mcpServers, users, projects } from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";
import type { CapabilityType, Effect, PolicyInfo, PolicyMatcher, PolicyScope } from "./types";

// The pure matcher lives in matcher.ts (no db imports, client-importable). It is
// re-exported here so existing server-side imports keep resolving from ./policy.
import { buildMatcher } from "./matcher";
export { buildMatcher, explainPolicy } from "./matcher";

/** A capability is usable only when explicitly allowed (the unmatched default is
 *  "allow", see buildMatcher). "ask" is treated as DENY until a real interactive
 *  approval gate exists — an admin who sets "Ask" expects a control, so it must
 *  fail safe (block), never silently allow. */
export function isUsable(effect: Effect): boolean {
  return effect === "allow";
}

/** Policies visible to a run (org system + own user + the project), as a matcher. */
export async function resolvePolicies(userId: string, projectId?: string | null): Promise<PolicyMatcher> {
  const filter = projectId
    ? or(
        eq(capabilityPolicies.scope, "system"),
        and(eq(capabilityPolicies.scope, "user"), eq(capabilityPolicies.userId, userId), isNull(capabilityPolicies.projectId)),
        and(eq(capabilityPolicies.scope, "project"), eq(capabilityPolicies.projectId, projectId)),
      )
    : or(
        eq(capabilityPolicies.scope, "system"),
        and(eq(capabilityPolicies.scope, "user"), eq(capabilityPolicies.userId, userId), isNull(capabilityPolicies.projectId)),
      );
  const rows = await db.select().from(capabilityPolicies).where(filter);
  return buildMatcher(rows.map((r) => ({
    scope: r.scope as PolicyScope, capabilityType: r.capabilityType as CapabilityType, capabilityKey: r.capabilityKey, effect: r.effect as Effect,
  })));
}

export async function listPolicies(): Promise<PolicyInfo[]> {
  // Left-join the subject tables so the drawer renders "Finance" / a person's
  // name instead of a raw id. System rows carry no subject and stay null.
  const rows = await db
    .select({
      id: capabilityPolicies.id, scope: capabilityPolicies.scope,
      capabilityType: capabilityPolicies.capabilityType, capabilityKey: capabilityPolicies.capabilityKey,
      effect: capabilityPolicies.effect, userId: capabilityPolicies.userId, projectId: capabilityPolicies.projectId,
      userName: users.name, userEmail: users.email, projectName: projects.name,
    })
    .from(capabilityPolicies)
    .leftJoin(users, eq(users.id, capabilityPolicies.userId))
    .leftJoin(projects, eq(projects.id, capabilityPolicies.projectId));
  return rows.map((r) => ({
    id: r.id, scope: r.scope as PolicyScope, capabilityType: r.capabilityType as CapabilityType,
    capabilityKey: r.capabilityKey, effect: r.effect as Effect,
    userId: r.userId, projectId: r.projectId,
    userName: r.userName, userEmail: r.userEmail, projectName: r.projectName,
  }));
}

/** Upsert one policy for a capability, scoped to system / a user / a project.
 *  The (scope, subject, capability) uniqueness is enforced by partial indexes;
 *  we match on the same tuple so a repeat call updates rather than duplicates.
 *  Returns the row id. Callers (the API route) validate the scope/subject combo. */
export async function setPolicy(input: {
  capabilityType: CapabilityType;
  capabilityKey: string;
  effect: Effect;
  scope: PolicyScope;
  userId?: string | null;
  projectId?: string | null;
  createdBy: string;
}): Promise<string> {
  const userId = input.scope === "user" ? input.userId ?? null : null;
  const projectId = input.scope === "project" ? input.projectId ?? null : null;
  // Atomic upsert on the scope's partial unique index — a check-then-insert would
  // race two concurrent admins into a duplicate-key error. targetWhere carries the
  // literal predicate so Postgres can infer the right partial index as arbiter.
  const conflict =
    input.scope === "system"
      ? { target: [capabilityPolicies.capabilityType, capabilityPolicies.capabilityKey], targetWhere: sql`scope = 'system'` }
      : input.scope === "user"
        ? { target: [capabilityPolicies.userId, capabilityPolicies.capabilityType, capabilityPolicies.capabilityKey], targetWhere: sql`scope = 'user'` }
        : { target: [capabilityPolicies.projectId, capabilityPolicies.capabilityType, capabilityPolicies.capabilityKey], targetWhere: sql`scope = 'project'` };
  const [row] = await db.insert(capabilityPolicies)
    .values({
      id: nanoid(), scope: input.scope, userId, projectId,
      capabilityType: input.capabilityType, capabilityKey: input.capabilityKey, effect: input.effect, createdBy: input.createdBy,
    })
    .onConflictDoUpdate({ ...conflict, set: { effect: input.effect, updatedAt: new Date() } })
    .returning({ id: capabilityPolicies.id });
  return row.id;
}

/** Org-wide live projects (not scoped to one owner) so the admin permissions UI
 *  can add a project exception for anyone's project. ownerName lets the picker
 *  disambiguate same-named projects across people. */
export async function listProjectsForPolicy(): Promise<{ id: string; name: string; ownerId: string; ownerName: string | null }[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, ownerId: projects.userId, ownerName: users.name, ownerEmail: users.email })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.userId))
    .where(projectNotDeleted)
    .orderBy(projects.name);
  return rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.ownerId, ownerName: r.ownerName || r.ownerEmail || null }));
}

/** Delete a policy, returning the row that was removed (or null) so the caller
 *  can audit what it contained — the id alone is unreconstructable after delete. */
export async function clearPolicy(id: string): Promise<PolicyInfo | null> {
  const [row] = await db.delete(capabilityPolicies).where(eq(capabilityPolicies.id, id)).returning();
  if (!row) return null;
  return {
    id: row.id, scope: row.scope as PolicyScope, capabilityType: row.capabilityType as CapabilityType,
    capabilityKey: row.capabilityKey, effect: row.effect as Effect,
    userId: row.userId, projectId: row.projectId,
    userName: null, userEmail: null, projectName: null,
  };
}

/** The set of governable capabilities (distinct skill + connector names) so the
 *  admin UI can show a row per capability with its current effect. */
export async function listCapabilityInventory(): Promise<{ capabilityType: CapabilityType; capabilityKey: string }[]> {
  const [skillRows, serverRows] = await Promise.all([
    db.selectDistinct({ name: skills.name }).from(skills),
    db.selectDistinct({ name: mcpServers.name }).from(mcpServers),
  ]);
  return [
    ...skillRows.map((r) => ({ capabilityType: "skill" as const, capabilityKey: r.name })),
    ...serverRows.map((r) => ({ capabilityType: "connector" as const, capabilityKey: r.name })),
  ];
}
