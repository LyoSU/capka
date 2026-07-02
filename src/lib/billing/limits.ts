import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { tiers, users, usage } from "@/lib/db/schema";
import { computeCost } from "@/lib/pricing";
import { getModelPrice, getLiveModelPrice, syncModelCatalog } from "@/lib/models/catalog";
import { log } from "@/lib/log";

/**
 * Per-user spend budgets on the SHARED (admin) provider key. Own-key users pay
 * their provider directly, so they are never evaluated here. Spend is summed from
 * the `usage` table (rows tagged `on_shared_key`) over three rolling windows.
 */

export type WindowKey = "h5" | "d7" | "d30";

export interface WindowStatus {
  window: WindowKey;
  // Settled spend (reconciled, pending=false) vs outstanding holds (pending=true).
  // `used` is their sum — what enforcement and the % bar are based on; the split
  // lets the UI show real spend without presenting estimates as committed.
  committed: number;
  reserved: number;
  used: number; // committed + reserved, in USD on the shared key
  limit: number | null; // USD cap for the window (null = unlimited)
  pct: number; // used/limit, 0..100+ — 0 when unlimited
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
// A db or an in-transaction handle — both expose the same query builder, so the
// windows sum reads identically whether or not it's inside reserveBudget's lock.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Committed (settled) vs reserved (outstanding holds) shared-key spend per window. */
export interface SpendSplit {
  committed: Record<WindowKey, number>;
  reserved: Record<WindowKey, number>;
}

/**
 * Shared-key spend for one user across all three windows in a single query,
 * bounded to the widest window (30d). Settled rows (pending=false) and holds
 * (pending=true) are summed SEPARATELY: their total drives enforcement (a
 * concurrent reserve must see another in-flight turn's hold), while the split
 * lets the UI distinguish real spend from estimates. Single source of truth for
 * both the UI status and the enforcement gate, so the two can never drift.
 */
async function spendWindows(exec: Executor, userId: string): Promise<SpendSplit> {
  const [row] = await exec
    .select({
      h5c: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.pending} = false and ${usage.createdAt} >= now() - interval '5 hours'), 0)`,
      h5r: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.pending} = true and ${usage.createdAt} >= now() - interval '5 hours'), 0)`,
      d7c: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.pending} = false and ${usage.createdAt} >= now() - interval '7 days'), 0)`,
      d7r: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.pending} = true and ${usage.createdAt} >= now() - interval '7 days'), 0)`,
      d30c: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.pending} = false), 0)`,
      d30r: sql<string>`coalesce(sum(${usage.costUsd}) filter (where ${usage.pending} = true), 0)`,
    })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.onSharedKey, true),
        sql`${usage.createdAt} >= now() - interval '30 days'`,
      ),
    );
  return {
    committed: { h5: Number(row?.h5c ?? 0), d7: Number(row?.d7c ?? 0), d30: Number(row?.d30c ?? 0) },
    reserved: { h5: Number(row?.h5r ?? 0), d7: Number(row?.d7r ?? 0), d30: Number(row?.d30r ?? 0) },
  };
}

async function sharedSpendWindows(userId: string): Promise<SpendSplit> {
  return spendWindows(db, userId);
}

function capFor(tier: Tier, w: WindowKey): number | null {
  const raw = w === "h5" ? tier.limit5h : w === "d7" ? tier.limitWeek : tier.limitMonth;
  // Unset (null/absent) means unlimited. A CONFIGURED value — including an
  // explicit 0 (a hard "no shared-key budget" deny) — is the cap, so 0 must
  // block spend, not be misread as "no limit". Only a non-finite/negative
  // garbage value falls back to unlimited.
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Full status for the UI (% per window) and for enforcement (blocked flag). */
export async function getLimitStatus(userId: string): Promise<LimitStatus> {
  const [tier, spend] = await Promise.all([getTierForUser(userId), sharedSpendWindows(userId)]);

  const windows: WindowStatus[] = ORDER.map((w) => {
    const committed = spend.committed[w];
    const reserved = spend.reserved[w];
    const used = committed + reserved;
    const limit = capFor(tier, w);
    // null = unlimited → 0%. A finite cap (incl. an explicit 0, a hard deny)
    // reads as full: any use over a 0 budget — or a divide-by-zero — pins to 999.
    const pct = limit === null ? 0 : limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : used > 0 ? 999 : 100;
    return { window: w, committed, reserved, used, limit, pct };
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
  // Catalog first (synced price book); if it's missing the model — a brand-new or
  // free model the sync hasn't caught yet — try OpenRouter's live price book before
  // giving up, so the estimate is still accurate instead of unknown.
  const price = (await getModelPrice(modelId)) ?? (await getLiveModelPrice(modelId));
  if (!price) return null;
  return computeCost(price, { inputTokens: ESTIMATE_INPUT_TOKENS, outputTokens: ESTIMATE_OUTPUT_TOKENS });
}

export type ReserveReason = "budget";

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

  // An unpriced model (not in the catalog, not resolvable live, or a local gateway
  // with no price book) is NOT blocked — refusing a free or brand-new model would
  // be worse than not billing it. It reserves a zero hold and reconciles to its
  // real (often zero) cost at finalize; a background sync is kicked so the catalog
  // can price it on the next turn.
  const priced = input.modelId ? await estimateTurnCost(input.modelId) : null;
  if (priced === null && input.modelId) void syncModelCatalog().catch(() => {});
  const estimate = priced ?? 0;

  const tier = await getTierForUser(input.userId);

  return await db.transaction(async (tx) => {
    // Serialize this user's budget ops so concurrent reserves see each other's
    // just-written holds. Transaction-scoped: released on commit/rollback.
    // 64-bit key: hashtext() is 32-bit, so two distinct users could collide and
    // needlessly serialize each other's budget ops. hashtextextended widens the
    // space to the full bigint the advisory-lock API takes.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`);

    const spend = await spendWindows(tx, input.userId);

    for (const w of ORDER) {
      const cap = capFor(tier, w);
      // Enforce on the EFFECTIVE total (settled + outstanding holds), so concurrent
      // turns reserve against each other.
      if (cap !== null && spend.committed[w] + spend.reserved[w] + estimate >= cap) {
        return { allowed: false, window: w, reason: "budget" as const };
      }
    }

    // ON CONFLICT DO NOTHING against uq_usage_one_pending_per_task: if a hold for
    // this task already exists (retry / coalesced turn), the budget is already
    // reserved by it — don't add a second pending row (which would double-count at
    // reconcile and, with the unique index, throw).
    await tx.insert(usage).values({
      id: nanoid(),
      taskId: input.taskId,
      userId: input.userId,
      provider: input.provider ?? "shared",
      model: input.modelId ?? "",
      costUsd: String(estimate),
      onSharedKey: true,
      pending: true,
    }).onConflictDoNothing();
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
