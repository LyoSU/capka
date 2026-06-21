import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { tiers, users, usage } from "@/lib/db/schema";

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
