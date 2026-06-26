import { sql, gte, lt, and, desc, eq } from "drizzle-orm";
import { requireAdmin, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { usage, users } from "@/lib/db/schema";

/**
 * Read side for the usage that runner.ts already records. Aggregates the `usage`
 * table over a rolling window: totals, a daily trend, top models, and per-user
 * spend — so an admin can see what's being spent, who's driving it, and which
 * way the trend is going.
 *
 * Scoped by `?scope=shared|own`:
 *  - shared (default): spend on the shared key — the organization's own bill.
 *  - own: usage on members' own provider keys — their money, shown so an admin
 *    can see how own-key users are using the platform.
 *
 * Only reconciled rows (`pending=false`) count: a pending row is an estimated
 * budget hold for an in-flight turn that will either become an actual cost or be
 * released, so counting it would mix estimates into the reported spend.
 */
export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();

  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1), 365);
  const scope = url.searchParams.get("scope") === "own" ? "own" : "shared";
  const since = new Date(Date.now() - days * 86_400_000);
  const prevSince = new Date(Date.now() - days * 2 * 86_400_000);

  const cost = sql<number>`coalesce(sum(${usage.costUsd}), 0)::float8`;
  const inTok = sql<number>`coalesce(sum(${usage.inputTokens}), 0)::bigint`;
  const cachedTok = sql<number>`coalesce(sum(${usage.cachedInputTokens}), 0)::bigint`;
  const outTok = sql<number>`coalesce(sum(${usage.outputTokens}), 0)::bigint`;
  const calls = sql<number>`count(*)::int`;
  const day = sql<string>`to_char(date_trunc('day', ${usage.createdAt}), 'YYYY-MM-DD')`;

  // pending=false (actuals only) + the chosen key scope, applied to every query.
  const base = and(eq(usage.pending, false), eq(usage.onSharedKey, scope === "shared"));

  const [totals, prev, series, byModel, byUser, recent] = await Promise.all([
    db
      .select({ cost, inputTokens: inTok, cachedInputTokens: cachedTok, outputTokens: outTok, calls })
      .from(usage)
      .where(and(gte(usage.createdAt, since), base))
      .then((r) => r[0]),
    // Equal-length window immediately before `since`, for trend deltas.
    db
      .select({ cost, calls })
      .from(usage)
      .where(and(gte(usage.createdAt, prevSince), lt(usage.createdAt, since), base))
      .then((r) => r[0]),
    db
      .select({ day, cost, calls })
      .from(usage)
      .where(and(gte(usage.createdAt, since), base))
      .groupBy(day)
      .orderBy(day),
    db
      .select({ model: usage.model, cost, calls, inputTokens: inTok, cachedInputTokens: cachedTok, outputTokens: outTok })
      .from(usage)
      .where(and(gte(usage.createdAt, since), base))
      .groupBy(usage.model)
      .orderBy(desc(cost))
      .limit(20),
    db
      .select({ userId: usage.userId, name: users.name, email: users.email, cost, calls })
      .from(usage)
      .leftJoin(users, eq(users.id, usage.userId))
      .where(and(gte(usage.createdAt, since), base))
      .groupBy(usage.userId, users.name, users.email)
      .orderBy(desc(cost))
      .limit(50),
    // Latest individual spends — "who spent what, on which model, when". Lets an
    // admin eyeball live activity and spot an anomaly without aggregation lag.
    db
      .select({
        id: usage.id,
        createdAt: usage.createdAt,
        model: usage.model,
        cost: sql<number>`coalesce(${usage.costUsd}, 0)::float8`,
        inputTokens: sql<number>`coalesce(${usage.inputTokens}, 0) + coalesce(${usage.cachedInputTokens}, 0)`,
        outputTokens: sql<number>`coalesce(${usage.outputTokens}, 0)`,
        userName: users.name,
        userEmail: users.email,
      })
      .from(usage)
      .leftJoin(users, eq(users.id, usage.userId))
      .where(and(gte(usage.createdAt, since), base))
      .orderBy(desc(usage.createdAt))
      .limit(15),
  ]);

  return Response.json({ days, scope, totals, prev, series, byModel, byUser, recent });
});
