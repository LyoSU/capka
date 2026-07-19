/**
 * "Needs attention" triggers for the analytics page, computed as a PURE function
 * of already-fetched aggregates so the thresholds can be unit-tested without a DB.
 * The route (src/app/api/admin/usage/route.ts) gathers the raw numbers and calls
 * this; the client renders one calm sentence per returned trigger.
 *
 * Money triggers (budget overrun, member near cap) are inherently about the SHARED
 * key — the org's own bill — so they only fire in the shared-key view. Reliability
 * triggers (failure spike, idle seats) are key-agnostic and fire in either view.
 */

// Thresholds — normative per the design spec (§A1, "Needs attention").
export const FAILURE_SPIKE_MIN_TURNS = 20; // too few turns → rate is noise
export const FAILURE_SPIKE_ABS_PP = 0.05; // +5 percentage points over the previous window
export const FAILURE_SPIKE_REL = 1.5; // and at least 1.5× the previous rate
export const NEAR_BUDGET_FRAC = 0.8; // member spend past 80% of their monthly cap
export const IDLE_DAYS = 14; // active seat, no turn for this many days

export interface AttentionMember {
  userId: string;
  name: string | null;
  status: string;
  /** Effective monthly cap in USD on the shared key (their tier, else the default
   *  tier). null = unlimited — never a near-budget candidate. */
  monthCap: number | null;
  /** Settled shared-key spend over the last 30 days. */
  sharedSpend30d: number;
  /** ISO timestamp of this user's most recent assistant turn, or null if never. */
  lastTurnAt: string | null;
  /** When the account was created. A seat younger than the idle window can't be
   *  "idle" yet — they were only just invited. null = unknown, treated as old. */
  createdAt: string | null;
}

export interface AttentionInput {
  scope: "shared" | "own";
  days: number;
  /** Instance monthly budget in USD, or null when unset. */
  budgetMonthly: number | null;
  /** Scoped, reconciled spend over the selected period (KPI "Spend"). */
  spend: number;
  turns: { completed: number; failed: number; cancelled: number };
  prevTurns: { completed: number; failed: number; cancelled: number };
  members: AttentionMember[];
  /** Injected for testability; defaults to Date.now() at the call site. */
  now: number;
}

export type AttentionTrigger =
  | { type: "budget-overrun-projected"; projected: number; budget: number }
  | { type: "member-near-budget"; userId: string; name: string; used: number; cap: number; pct: number }
  | { type: "failure-spike"; rate: number; prevRate: number; turns: number }
  | { type: "idle-seats"; count: number; names: string[] };

/** Failure rate = failed of concluded (completed + failed) turns. Cancelled turns
 *  are user-initiated stops, neither success nor failure, so they're excluded from
 *  the rate (but still counted toward the ≥20-turn volume gate). */
export function failureRate(t: { completed: number; failed: number }): number {
  const concluded = t.completed + t.failed;
  return concluded > 0 ? t.failed / concluded : 0;
}

export function computeAttention(input: AttentionInput): AttentionTrigger[] {
  const { scope, days, budgetMonthly, spend, turns, prevTurns, members, now } = input;
  const out: AttentionTrigger[] = [];

  // Projected monthly spend past the instance budget (shared key only, budget set).
  if (scope === "shared" && budgetMonthly != null && budgetMonthly > 0 && days > 0) {
    const projected = (spend / days) * 30;
    if (projected > budgetMonthly) {
      out.push({ type: "budget-overrun-projected", projected, budget: budgetMonthly });
    }
  }

  // Members past 80% of their effective monthly cap (shared key only).
  if (scope === "shared") {
    for (const m of members) {
      if (m.monthCap != null && m.monthCap > 0 && m.sharedSpend30d > NEAR_BUDGET_FRAC * m.monthCap) {
        out.push({
          type: "member-near-budget",
          userId: m.userId,
          name: m.name ?? m.userId,
          used: m.sharedSpend30d,
          cap: m.monthCap,
          pct: m.sharedSpend30d / m.monthCap,
        });
      }
    }
  }

  // Failure spike vs the previous equal-length window.
  const totalTurns = turns.completed + turns.failed + turns.cancelled;
  const rate = failureRate(turns);
  const prevRate = failureRate(prevTurns);
  if (
    totalTurns >= FAILURE_SPIKE_MIN_TURNS &&
    rate > 0 &&
    rate >= prevRate + FAILURE_SPIKE_ABS_PP &&
    rate >= FAILURE_SPIKE_REL * prevRate
  ) {
    out.push({ type: "failure-spike", rate, prevRate, turns: totalTurns });
  }

  // Idle seats: active-status users with no turn in the last IDLE_DAYS (or never).
  // A seat created within the window is excluded — a just-invited member hasn't
  // had time to be idle, so flagging them would be a false alarm.
  const cutoff = now - IDLE_DAYS * 86_400_000;
  const idle = members.filter(
    (m) =>
      m.status === "active" &&
      (m.createdAt == null || new Date(m.createdAt).getTime() <= cutoff) &&
      (m.lastTurnAt == null || new Date(m.lastTurnAt).getTime() < cutoff),
  );
  if (idle.length > 0) {
    out.push({ type: "idle-seats", count: idle.length, names: idle.slice(0, 5).map((m) => m.name ?? m.userId) });
  }

  return out;
}
