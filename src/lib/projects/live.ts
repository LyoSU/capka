import { and, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { NotFoundError } from "@/lib/errors";

/** The single source of truth for "this project is not mid-deletion". A tombstoned
 *  project (deletedAt set) must vanish from every query until the worker finishes
 *  tearing it down and physically removes the row — so every read/gate composes
 *  this condition (or the helpers below) instead of trusting the convention. */
export const projectNotDeleted: SQL = isNull(projects.deletedAt);

/** Load a live project the caller owns, or throw 404. */
export async function requireLiveProject(id: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId), projectNotDeleted))
    .limit(1);
  if (!project) throw new NotFoundError("Project");
  return project;
}

/** Owner-scoped liveness check for gate paths that only need a yes/no. */
export async function isLiveProject(id: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId), projectNotDeleted))
    .limit(1);
  return !!row;
}
