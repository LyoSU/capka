import { and, eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { capabilityPolicies, skills, mcpServers } from "@/lib/db/schema";
import type { CapabilityType, Effect, PolicyInfo, PolicyMatcher, PolicyRow, PolicyScope } from "./types";

const SCOPE_RANK: Record<PolicyScope, number> = { system: 0, user: 1, project: 2 };

/** Build a lookup from policy rows: most-specific scope wins; default allow. Pure. */
export function buildMatcher(rows: PolicyRow[]): PolicyMatcher {
  const best = new Map<string, { rank: number; effect: Effect }>();
  for (const r of rows) {
    const k = `${r.capabilityType}:${r.capabilityKey}`;
    const rank = SCOPE_RANK[r.scope];
    const cur = best.get(k);
    if (!cur || rank > cur.rank) best.set(k, { rank, effect: r.effect });
  }
  return { effect: (type, key) => best.get(`${type}:${key}`)?.effect ?? "allow" };
}

/** deny is the only effect that removes a capability in G1 (ask behaves as allow). */
export function isUsable(effect: Effect): boolean {
  return effect !== "deny";
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
  const rows = await db.select().from(capabilityPolicies);
  return rows.map((r) => ({
    id: r.id, scope: r.scope as PolicyScope, capabilityType: r.capabilityType as CapabilityType,
    capabilityKey: r.capabilityKey, effect: r.effect as Effect,
  }));
}

/** Upsert a system-scope policy for a capability. Returns the row id. */
export async function setPolicy(input: {
  capabilityType: CapabilityType;
  capabilityKey: string;
  effect: Effect;
  createdBy: string;
}): Promise<string> {
  const existing = await db.select({ id: capabilityPolicies.id }).from(capabilityPolicies)
    .where(and(
      eq(capabilityPolicies.scope, "system"),
      isNull(capabilityPolicies.userId),
      isNull(capabilityPolicies.projectId),
      eq(capabilityPolicies.capabilityType, input.capabilityType),
      eq(capabilityPolicies.capabilityKey, input.capabilityKey),
    )).limit(1);
  if (existing[0]) {
    await db.update(capabilityPolicies).set({ effect: input.effect, updatedAt: new Date() }).where(eq(capabilityPolicies.id, existing[0].id));
    return existing[0].id;
  }
  const id = nanoid();
  await db.insert(capabilityPolicies).values({
    id, scope: "system", userId: null, projectId: null,
    capabilityType: input.capabilityType, capabilityKey: input.capabilityKey, effect: input.effect, createdBy: input.createdBy,
  });
  return id;
}

export async function clearPolicy(id: string): Promise<void> {
  await db.delete(capabilityPolicies).where(eq(capabilityPolicies.id, id));
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
