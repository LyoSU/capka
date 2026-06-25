import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { tiers, users, usage } from "@/lib/db/schema";
import { computeCost } from "@/lib/pricing";
import { getModelPrice } from "@/lib/models/catalog";
import { log } from "@/lib/log";

/**
 * Per-user spend budgets on the SHARED (admin) provider key. Own-key users pay
 * their provider directly, so they are never evaluated here. Spend is summed from
 * the `usage` table (rows tagged `on_shared_key`) over three rolling windows.
 */

export type WindowKey = "h5" | "d7" | "d30";

export interface WindowStatus {
  window: WindowKey;
  used: number; // USD spent in the window on the shared key
  limit: number | null; // USD cap for the window (null = unlimited)
  pct: number; // 0..100+ — 0 when unlimited
}

export interface LimitStatus {
  tierId: string;
  tierName: string;
  windows: WindowStatus[];
  /** True when any capped window is at or over its limit. */
  blocked: boolean;
  blockedWindow: WindowKey | null;
}

export interface Tier {
  id: string;
  name: string;
  limit5h: string | null;
  limitWeek: string | null;
  limitMonth: string | null;
  isDefault: boolean | null;
}

const ORDER: WindowKey[] = ["h5", "d7", "d30"];

/** The user's assigned tier, falling back to the instance default tier. */
export async function getTierForUser(userId: string): Promise<Tier> {
  const [user] = await db
    .select({ tierId: users.tierId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user?.tierId) {
    const [t] = await db.select().from(tiers).where(eq(tiers.id, user.tierId)).limit(1);
    if (t) return t;
  }
  return getDefaultTier();
}

/** The instance default tier, creating it (unlimited) if it somehow went missing. */
export async function getDefaultTier(): Promise<Tier> {
  const [t] = await db.select().from(tiers).where(eq(tiers.isDefault, true)).limit(1);
  if (t) return t;
  const seeded: Tier = {
    id: "default",
    name: "Default",
    limit5h: null,
    limitWeek: null,
    limitMonth: null,
    isDefault: true,
  };
  await db.insert(tiers).values(seeded).onConflictDoNothing();
  return seeded;
}

/**
 * Shared-key spend for one user across all three windows in a single query,
 * bounded to the widest window (30d) so we scan the smallest slice possible.
 */
async function sharedSpendWindows(userId: string): Promise<Record<WindowKey, number>> {
  const [row] = await db
    .select({
      h5: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.createdAt} >= now() - interval '5 hours'), 0)`,
      d7: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.createdAt} >= now() - interval '7 days'), 0)`,
      d30: sql<string>`coalesce(sum(${usage.costUsd}), 0)`,
    })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.onSharedKey, true),
        sql`${usage.createdAt} >= now() - interval '30 days'`,
      ),
    );
  return { h5: Number(row?.h5 ?? 0), d7: Number(row?.d7 ?? 0), d30: Number(row?.d30 ?? 0) };
}

function capFor(tier: Tier, w: WindowKey): number | null {
  const raw = w === "h5" ? tier.limit5h : w === "d7" ? tier.limitWeek : tier.limitMonth;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Full status for the UI (% per window) and for enforcement (blocked flag). */
export async function getLimitStatus(userId: string): Promise<LimitStatus> {
  const [tier, spend] = await Promise.all([getTierForUser(userId), sharedSpendWindows(userId)]);

  const windows: WindowStatus[] = ORDER.map((w) => {
    const used = spend[w];
    const limit = capFor(tier, w);
    const pct = limit ? Math.min(999, Math.round((used / limit) * 100)) : 0;
    return { window: w, used, limit, pct };
  });

  const blocked = windows.find((w) => w.limit !== null && w.used >= w.limit) ?? null;
  return {
    tierId: tier.id,
    tierName: tier.name,
    windows,
    blocked: !!blocked,
    blockedWindow: blocked?.window ?? null,
  };
}

/**
 * Enforcement gate, called before enqueuing a task. Only shared-key requests are
 * checked; own-key users and unlimited tiers short-circuit to allowed. Returns
 * the tripped window when blocked so the caller can build a precise message.
 */
export async function checkBudget(
  userId: string,
  onSharedKey: boolean,
): Promise<{ allowed: boolean; window: WindowKey | null }> {
  if (!onSharedKey) return { allowed: true, window: null };
  const status = await getLimitStatus(userId);
  return { allowed: !status.blocked, window: status.blockedWindow };
}

// A typical turn's token shape, used only to size the pre-run hold. The
// reconcile at finalize replaces the estimate with the real figures, so this
// just needs to be a sensible non-zero reservation — big enough that concurrent
// turns meaningfully reserve against each other, small enough not to lock out a
// modest cap on the very first turn.
const ESTIMATE_INPUT_TOKENS = 20_000;
const ESTIMATE_OUTPUT_TOKENS = 4_000;

/**
 * Estimated USD for one turn on `modelId`. Returns null when the model has no
 * known price — the caller fails closed on a shared key, since an unpriceable
 * turn can be neither bounded nor billed.
 */
async function estimateTurnCost(modelId: string): Promise<number | null> {
  const price = await getModelPrice(modelId);
  if (!price) return null;
  return computeCost(price, { inputTokens: ESTIMATE_INPUT_TOKENS, outputTokens: ESTIMATE_OUTPUT_TOKENS });
}

export type ReserveReason = "budget" | "unpriced";

/**
 * Atomically reserve budget for a turn BEFORE it runs: under a per-user lock,
 * sum committed spend + outstanding holds across the windows, refuse if any cap
 * would be exceeded, otherwise write a pending hold carrying the estimate. The
 * runner reconciles that hold to the real cost at finalize, or it's released if
 * the turn never runs.
 *
 * Replaces the old check-then-spend gate: a turn's own estimated cost is counted
 * before it runs (no single-turn free pass) and concurrent turns across chats
 * reserve against each other's holds (no TOCTOU overshoot).
 */
export async function reserveBudget(input: {
  userId: string;
  taskId: string;
  onSharedKey: boolean;
  modelId?: string;
  provider?: string;
}): Promise<{ allowed: boolean; window: WindowKey | null; reason: ReserveReason | null }> {
  // Own-key turns pay their own provider — never gated, never held.
  if (!input.onSharedKey) return { allowed: true, window: null, reason: null };

  const estimate = input.modelId ? await estimateTurnCost(input.modelId) : null;
  if (estimate === null) return { allowed: false, window: null, reason: "unpriced" };

  const tier = await getTierForUser(input.userId);

  return await db.transaction(async (tx) => {
    // Serialize this user's budget ops so concurrent reserves see each other's
    // just-written holds. Transaction-scoped: released on commit/rollback.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`);

    const [row] = await tx
      .select({
        h5: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.createdAt} >= now() - interval '5 hours'), 0)`,
        d7: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.createdAt} >= now() - interval '7 days'), 0)`,
        d30: sql<string>`coalesce(sum(${usage.costUsd}), 0)`,
      })
      .from(usage)
      .where(
        and(
          eq(usage.userId, input.userId),
          eq(usage.onSharedKey, true),
          sql`${usage.createdAt} >= now() - interval '30 days'`,
        ),
      );

    const spend: Record<WindowKey, number> = {
      h5: Number(row?.h5 ?? 0),
      d7: Number(row?.d7 ?? 0),
      d30: Number(row?.d30 ?? 0),
    };

    for (const w of ORDER) {
      const cap = capFor(tier, w);
      if (cap !== null && spend[w] + estimate >= cap) {
        return { allowed: false, window: w, reason: "budget" as const };
      }
    }

    await tx.insert(usage).values({
      id: nanoid(),
      taskId: input.taskId,
      userId: input.userId,
      provider: input.provider ?? "shared",
      model: input.modelId ?? "",
      costUsd: String(estimate),
      onSharedKey: true,
      pending: true,
    });
    return { allowed: true, window: null, reason: null };
  });
}

/** Release a turn's outstanding hold — it folded into another turn or won't run. */
export async function releaseHold(taskId: string): Promise<void> {
  try {
    await db.delete(usage).where(and(eq(usage.taskId, taskId), eq(usage.pending, true)));
  } catch (err) {
    log.error("hold release failed (non-fatal)", { taskId, err: String(err) });
  }
}
