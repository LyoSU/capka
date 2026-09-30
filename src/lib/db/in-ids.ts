import { sql, type SQLWrapper } from "drizzle-orm";

/** `expr IN (ids)` with the ids bound as ONE array parameter: `inArray` spends a bind
 *  parameter per id and Postgres caps a statement at 65535, so a list that grows with the
 *  data (a chat's messages, a space's notes) must not go through it. */
export const inIds = (expr: SQLWrapper, ids: string[]) =>
  sql`${expr} = ANY(${sql.param(ids)}::text[])`;
