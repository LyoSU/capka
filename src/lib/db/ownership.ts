import { eq, and, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";

type Cols = { id: PgColumn; userId: PgColumn };

/** Find a row owned by userId. Returns null if not found or not owned. */
export async function findOwned<T extends PgTable & Cols>(
  table: T,
  id: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [row] = await (db as any)
    .select()
    .from(table)
    .where(and(eq(table.id, id) as SQL, eq(table.userId, userId) as SQL))
    .limit(1);
  return (row as Record<string, unknown>) ?? null;
}

/** Find a row owned by userId or throw 404. */
export async function requireOwned<T extends PgTable & Cols>(
  table: T,
  id: string,
  userId: string,
  label?: string,
): Promise<Record<string, unknown>> {
  const row = await findOwned(table, id, userId);
  if (!row) throw new NotFoundError(label);
  return row;
}
