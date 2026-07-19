import { sql, gte, lt, and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireAdmin, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { usage, users, messages, chats, projects, tiers } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { getDefaultTier } from "@/lib/billing/limits";
import { computeAttention, type AttentionMember } from "@/lib/usage/attention";

/**
 * Read side for the analytics page. Two coherent sources, never conflated:
 *
 *  - MONEY (totals, daily series, per-model/user/project/channel breakdowns,
 *    recent list) comes from the `usage` table — the reconciled spend ledger —
 *    scoped by `?scope=shared|own` and `pending=false`, exactly as before.
 *  - TURN OUTCOMES (completed/failed/cancelled counts, active members, last
 *    activity) come from assistant `messages` aggregated by `metadata->>'status'`.
 *    Messages are never retention-pruned, so this stays accurate over the full
 *    90-day window; the `tasks` table (30-day retention) is deliberately avoided.
 *
 * Optional filters (`userId`, `model`, `projectId`, `channel`) narrow every
 * aggregate. Project and channel are turn dimensions: for the money queries they
 * are applied by bridging each usage row to its turn's assistant message
 * (`messages.metadata->>'taskId' = usage.taskId`) and reading the chat's current
 * project and the parent user message's `platform`. That bridge runs through
 * `messages` (never pruned), so 90-day project/channel spend stays honest even
 * though `tasks` is pruned at 30 days.
 *
 * Only reconciled rows (`pending=false`) count toward spend: a pending row is an
 * estimated hold for an in-flight turn, so counting it would mix estimates in.
 */
export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();

  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1), 365);
  const scope = url.searchParams.get("scope") === "own" ? "own" : "shared";
  const since = new Date(Date.now() - days * 86_400_000);
  const prevSince = new Date(Date.now() - days * 2 * 86_400_000);

  // Optional dimension filters. Empty string / missing → no filter.
  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);
  const fUser = clean(url.searchParams.get("userId"));
  const fModel = clean(url.searchParams.get("model"));
  const fProject = clean(url.searchParams.get("projectId"));
  const rawChannel = clean(url.searchParams.get("channel"));
  const fChannel = rawChannel === "web" || rawChannel === "telegram" || rawChannel === "automation" ? rawChannel : null;

  const cost = sql<number>`coalesce(sum(${usage.costUsd}), 0)::float8`;
  const inTok = sql<number>`coalesce(sum(${usage.inputTokens}), 0)::bigint`;
  const cachedTok = sql<number>`coalesce(sum(${usage.cachedInputTokens}), 0)::bigint`;
  const outTok = sql<number>`coalesce(sum(${usage.outputTokens}), 0)::bigint`;
  const calls = sql<number>`count(*)::int`;
  const day = sql<string>`to_char(date_trunc('day', ${usage.createdAt}), 'YYYY-MM-DD')`;

  // pending=false (actuals only) + the chosen key scope, applied to every money query.
  const base = and(eq(usage.pending, false), eq(usage.onSharedKey, scope === "shared"));

  // Project/channel are turn dimensions with no column on `usage`; restrict usage
  // rows to the turns matching them by bridging through the assistant message.
  const dimSubquery =
    fProject || fChannel
      ? sql`${usage.taskId} in (
          select am.metadata->>'taskId'
          from ${messages} am
          join ${chats} c on c.id = am.chat_id
          left join ${messages} um on um.id = am.parent_id
          where am.role = 'assistant' and am.metadata->>'taskId' is not null
          ${fProject ? sql`and c.project_id = ${fProject}` : sql``}
          ${fChannel ? sql`and coalesce(um.platform, 'web') = ${fChannel}` : sql``}
        )`
      : undefined;

  // Filters shared by every money query. userId/model live directly on `usage`.
  const usageFilters = and(
    base,
    fUser ? eq(usage.userId, fUser) : undefined,
    fModel ? eq(usage.model, fModel) : undefined,
    dimSubquery,
  );
  const inWindow = and(gte(usage.createdAt, since), usageFilters);
  const inPrevWindow = and(gte(usage.createdAt, prevSince), lt(usage.createdAt, since), usageFilters);

  // ── Turn (message) side. am = assistant turn, um = its parent user message
  // (channel truth). Joined to chats for owner + current project. ──────────────
  const am = alias(messages, "am");
  const um = alias(messages, "um");
  const turnStatus = sql<string>`${am.metadata}->>'status'`;
  // A turn belongs to the shared or own-key view through its settled usage rows —
  // otherwise the UI would divide scope-filtered spend by both scopes' turns and
  // the turn KPIs would ignore the Shared/Own toggle entirely. A turn with no
  // settled usage at all (failed before any provider call) is key-neutral and
  // stays visible in both views: it matters for reliability, not for either bill.
  const turnScope = sql`(
    exists (select 1 from ${usage} u where u.task_id = ${am.metadata}->>'taskId' and u.pending = false and u.on_shared_key = ${scope === "shared"})
    or not exists (select 1 from ${usage} u where u.task_id = ${am.metadata}->>'taskId' and u.pending = false)
  )`;
  const turnBase = and(
    eq(am.role, "assistant"),
    sql`${am.metadata}->>'status' in ('completed', 'failed', 'cancelled')`,
    turnScope,
    fUser ? eq(chats.userId, fUser) : undefined,
    // Failed turns recorded before v0.10.12 lack metadata.model (the runner now
    // writes it), so a model filter slightly understates HISTORICAL failure rates.
    fModel ? sql`${am.metadata}->>'model' = ${fModel}` : undefined,
    fProject ? eq(chats.projectId, fProject) : undefined,
    fChannel ? sql`coalesce(${um.platform}, 'web') = ${fChannel}` : undefined,
  );
  const turnCount = sql<number>`count(*)::int`;

  // Instance-wide turn outcomes for the "Needs attention" block — deliberately
  // ignoring the ad-hoc dimension filters AND the key scope: an alert about the
  // whole instance must not disappear because the admin happens to be looking at
  // one member or one model.
  const attnTurnQuery = (from: Date, to?: Date) =>
    db
      .select({ status: sql<string>`${messages.metadata}->>'status'`, n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(
        eq(messages.role, "assistant"),
        sql`${messages.metadata}->>'status' in ('completed', 'failed', 'cancelled')`,
        gte(messages.createdAt, from),
        to ? lt(messages.createdAt, to) : undefined,
      ))
      .groupBy(sql`${messages.metadata}->>'status'`);

  const turnQuery = (from: Date, to?: Date) =>
    db
      .select({ status: turnStatus, n: turnCount })
      .from(am)
      .innerJoin(chats, eq(chats.id, am.chatId))
      .leftJoin(um, eq(um.id, am.parentId))
      .where(and(turnBase, gte(am.createdAt, from), to ? lt(am.createdAt, to) : undefined))
      .groupBy(turnStatus);

  const defaultTierP = getDefaultTier();
  const budgetRawP = getSetting("usage_monthly_budget_usd");

  const [
    totals,
    prev,
    series,
    byModel,
    byUser,
    recent,
    byProject,
    byChannel,
    turnRows,
    prevTurnRows,
    activeRow,
    withAccessRow,
    memberTurns,
    // Filter option lists (period + scope, ignoring the dimension filters so the
    // popover always offers the full set).
    optProjects,
    optModels,
    // Attention inputs (instance-wide, independent of the ad-hoc filters AND the
    // key-scope toggle — an alert must not vanish because of what's on screen).
    allUsers,
    allTiers,
    sharedSpend30d,
    lastTurnAll,
    attnSpendRow,
    attnTurnRows,
    attnPrevTurnRows,
    defaultTier,
    budgetRaw,
  ] = await Promise.all([
    db.select({ cost, inputTokens: inTok, cachedInputTokens: cachedTok, outputTokens: outTok, calls }).from(usage).where(inWindow).then((r) => r[0]),
    db.select({ cost, calls }).from(usage).where(inPrevWindow).then((r) => r[0]),
    db.select({ day, cost, calls }).from(usage).where(inWindow).groupBy(day).orderBy(day),
    db
      .select({ model: usage.model, cost, calls, inputTokens: inTok, cachedInputTokens: cachedTok, outputTokens: outTok })
      .from(usage)
      .where(inWindow)
      .groupBy(usage.model)
      .orderBy(desc(cost))
      .limit(20),
    db
      .select({ userId: usage.userId, name: users.name, email: users.email, cost, calls })
      .from(usage)
      .leftJoin(users, eq(users.id, usage.userId))
      .where(inWindow)
      .groupBy(usage.userId, users.name, users.email)
      .orderBy(desc(cost))
      .limit(50),
    db
      .select({
        id: usage.id,
        createdAt: usage.createdAt,
        model: usage.model,
        cost: sql<number>`coalesce(${usage.costUsd}, 0)::float8`,
        inputTokens: sql<number>`coalesce(${usage.inputTokens}, 0) + coalesce(${usage.cachedInputTokens}, 0)`,
        outputTokens: sql<number>`coalesce(${usage.outputTokens}, 0)`,
        userId: usage.userId,
        userName: users.name,
        userEmail: users.email,
      })
      .from(usage)
      .leftJoin(users, eq(users.id, usage.userId))
      .where(inWindow)
      .orderBy(desc(usage.createdAt))
      .limit(40),
    // Spend by the chat's CURRENT project, bridged usage → turn → chat. Scope- and
    // filter-aware like the other money breakdowns; unattributable rows (no turn
    // message) fall outside the inner join and simply aren't broken down.
    db
      .select({ projectId: chats.projectId, name: projects.name, cost, calls })
      .from(usage)
      .innerJoin(am, sql`${am.metadata}->>'taskId' = ${usage.taskId} and ${am.role} = 'assistant'`)
      .innerJoin(chats, eq(chats.id, am.chatId))
      .leftJoin(projects, eq(projects.id, chats.projectId))
      .where(inWindow)
      .groupBy(chats.projectId, projects.name)
      .orderBy(desc(cost)),
    // Spend by channel = platform of the turn's parent user message.
    db
      .select({ channel: sql<string>`coalesce(${um.platform}, 'web')`, cost, calls })
      .from(usage)
      .innerJoin(am, sql`${am.metadata}->>'taskId' = ${usage.taskId} and ${am.role} = 'assistant'`)
      .leftJoin(um, eq(um.id, am.parentId))
      .where(inWindow)
      .groupBy(sql`coalesce(${um.platform}, 'web')`)
      .orderBy(desc(cost)),
    turnQuery(since),
    turnQuery(prevSince, since),
    // Active members = distinct chat owners with ≥1 turn in the period.
    db
      .select({ n: sql<number>`count(distinct ${chats.userId})::int` })
      .from(am)
      .innerJoin(chats, eq(chats.id, am.chatId))
      .leftJoin(um, eq(um.id, am.parentId))
      .where(and(turnBase, gte(am.createdAt, since)))
      .then((r) => r[0]),
    db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.status, "active")).then((r) => r[0]),
    // Per-member turns + last activity in the period (People tab columns).
    db
      .select({ userId: chats.userId, turns: turnCount, lastAt: sql<string>`max(${am.createdAt})` })
      .from(am)
      .innerJoin(chats, eq(chats.id, am.chatId))
      .leftJoin(um, eq(um.id, am.parentId))
      .where(and(turnBase, gte(am.createdAt, since)))
      .groupBy(chats.userId),
    // Projects that saw ≥1 turn in the period, for the filter popover (unfiltered).
    db
      .select({ id: chats.projectId, name: projects.name })
      .from(am)
      .innerJoin(chats, eq(chats.id, am.chatId))
      .innerJoin(projects, eq(projects.id, chats.projectId))
      .where(and(eq(am.role, "assistant"), sql`${am.metadata}->>'status' is not null`, gte(am.createdAt, since)))
      .groupBy(chats.projectId, projects.name)
      .orderBy(projects.name),
    // Models with spend in the period + scope, for the filter popover (unfiltered).
    db.selectDistinct({ model: usage.model }).from(usage).where(and(gte(usage.createdAt, since), base)).orderBy(usage.model),
    // ── Attention: instance-wide, no ad-hoc filters. ──
    db.select({ id: users.id, name: users.name, status: users.status, tierId: users.tierId, createdAt: users.createdAt }).from(users),
    db.select({ id: tiers.id, limitMonth: tiers.limitMonth }).from(tiers),
    db
      .select({ userId: usage.userId, spend: sql<number>`coalesce(sum(${usage.costUsd}), 0)::float8` })
      .from(usage)
      .where(and(eq(usage.pending, false), eq(usage.onSharedKey, true), sql`${usage.createdAt} >= now() - interval '30 days'`))
      .groupBy(usage.userId),
    db
      .select({ userId: chats.userId, lastAt: sql<string>`max(${am.createdAt})` })
      .from(am)
      .innerJoin(chats, eq(chats.id, am.chatId))
      .where(and(eq(am.role, "assistant"), sql`${am.metadata}->>'status' is not null`))
      .groupBy(chats.userId),
    // Settled shared-key spend over the window, unfiltered — the budget projection
    // is about the org's whole bill regardless of the current view.
    db
      .select({ cost })
      .from(usage)
      .where(and(eq(usage.pending, false), eq(usage.onSharedKey, true), gte(usage.createdAt, since)))
      .then((r) => r[0]),
    attnTurnQuery(since),
    attnTurnQuery(prevSince, since),
    defaultTierP,
    budgetRawP,
  ]);

  const foldTurns = (rows: { status: string; n: number }[]) => {
    const out = { completed: 0, failed: 0, cancelled: 0 };
    for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = Number(r.n);
    return out;
  };
  const turns = foldTurns(turnRows);
  const prevTurns = foldTurns(prevTurnRows);

  const budgetMonthly = budgetRaw != null && budgetRaw !== "" && Number.isFinite(Number(budgetRaw)) ? Number(budgetRaw) : null;

  // Assemble per-member attention rows: effective monthly cap (their tier, else
  // the default tier), 30-day shared-key spend, and last-ever turn timestamp.
  const tierCap = new Map(allTiers.map((t) => [t.id, t.limitMonth == null ? null : Number(t.limitMonth)]));
  const defaultCap = defaultTier.limitMonth == null ? null : Number(defaultTier.limitMonth);
  const spendMap = new Map(sharedSpend30d.map((r) => [r.userId, Number(r.spend)]));
  const lastMap = new Map(lastTurnAll.map((r) => [r.userId, r.lastAt]));
  const members: AttentionMember[] = allUsers.map((u) => ({
    userId: u.id,
    name: u.name,
    status: u.status,
    monthCap: u.tierId && tierCap.has(u.tierId) ? tierCap.get(u.tierId)! : defaultCap,
    sharedSpend30d: spendMap.get(u.id) ?? 0,
    lastTurnAt: lastMap.get(u.id) ?? null,
    createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
  }));

  // Alerts get the INSTANCE-WIDE aggregates, never the filtered ones on screen —
  // picking one member or model must not hide a budget overrun or failure spike.
  const attention = computeAttention({
    scope,
    days,
    budgetMonthly,
    spend: attnSpendRow?.cost ?? 0,
    turns: foldTurns(attnTurnRows),
    prevTurns: foldTurns(attnPrevTurnRows),
    members,
    now: Date.now(),
  });

  return Response.json({
    days,
    scope,
    filters: { userId: fUser, model: fModel, projectId: fProject, channel: fChannel },
    totals,
    prev,
    series,
    byModel,
    byUser,
    recent,
    byProject,
    byChannel,
    turns,
    prevTurns,
    activeMembers: activeRow?.n ?? 0,
    withAccess: withAccessRow?.n ?? 0,
    memberTurns,
    budget: { monthly: budgetMonthly },
    attention,
    options: {
      members: allUsers.map((u) => ({ id: u.id, name: u.name })),
      projects: optProjects.filter((p) => p.id).map((p) => ({ id: p.id as string, name: p.name })),
      models: optModels.map((m) => m.model).filter(Boolean),
    },
  });
});
