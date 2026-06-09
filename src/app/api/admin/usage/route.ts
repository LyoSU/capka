import { sql, gte, desc, eq } from "drizzle-orm";
import { requireAdmin, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { usage, users } from "@/lib/db/schema";

/**
 * Read side for the usage that runner.ts already records. Aggregates the `usage`
 * table over a rolling window: totals, top models, and per-user spend — so an
 * admin can see what the shared provider key is costing and who is driving it.
 */
export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();

  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000);

  const cost = sql<number>`coalesce(sum(${usage.costUsd}), 0)::float8`;
  const inTok = sql<number>`coalesce(sum(${usage.inputTokens}), 0)::bigint`;
  const cachedTok = sql<number>`coalesce(sum(${usage.cachedInputTokens}), 0)::bigint`;
  const outTok = sql<number>`coalesce(sum(${usage.outputTokens}), 0)::bigint`;
  const calls = sql<number>`count(*)::int`;

  const [totals, byModel, byUser] = await Promise.all([
    db
      .select({ cost, inputTokens: inTok, cachedInputTokens: cachedTok, outputTokens: outTok, calls })
      .from(usage)
      .where(gte(usage.createdAt, since))
      .then((r) => r[0]),
    db
      .select({ model: usage.model, cost, calls, inputTokens: inTok, outputTokens: outTok })
      .from(usage)
      .where(gte(usage.createdAt, since))
      .groupBy(usage.model)
      .orderBy(desc(cost))
      .limit(20),
    db
      .select({ userId: usage.userId, name: users.name, email: users.email, cost, calls })
      .from(usage)
      .leftJoin(users, eq(users.id, usage.userId))
      .where(gte(usage.createdAt, since))
      .groupBy(usage.userId, users.name, users.email)
      .orderBy(desc(cost))
      .limit(50),
  ]);

  return Response.json({ days, totals, byModel, byUser });
});
