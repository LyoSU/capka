import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userMutedResources } from "@/lib/db/schema";

/**
 * Per-user opt-out of shared resources. A shared (system/project) skill or MCP
 * connector is on for everyone by the admin's global flag; a user can mute it
 * for themselves without affecting others. Presence of a row = muted.
 */
export type MutedKind = "skill" | "mcp";

/** The set of resource ids this user has muted for a kind. */
export async function mutedIds(userId: string, kind: MutedKind): Promise<Set<string>> {
  const rows = await db
    .select({ id: userMutedResources.resourceId })
    .from(userMutedResources)
    .where(and(eq(userMutedResources.userId, userId), eq(userMutedResources.kind, kind)));
  return new Set(rows.map((r) => r.id));
}

/** Mute (insert) or unmute (delete) a shared resource for one user. */
export async function setMuted(userId: string, kind: MutedKind, resourceId: string, muted: boolean): Promise<void> {
  if (muted) {
    await db.insert(userMutedResources).values({ userId, kind, resourceId }).onConflictDoNothing();
  } else {
    await db
      .delete(userMutedResources)
      .where(
        and(
          eq(userMutedResources.userId, userId),
          eq(userMutedResources.kind, kind),
          eq(userMutedResources.resourceId, resourceId),
        ),
      );
  }
}
