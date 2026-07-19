import { describe, it, expect } from "vitest";
import { computeAttention, failureRate, type AttentionInput, type AttentionMember } from "./attention";

const NOW = Date.UTC(2026, 6, 19); // 2026-07-19
const days = (n: number) => NOW - n * 86_400_000;

function base(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    scope: "shared",
    days: 30,
    budgetMonthly: null,
    spend: 0,
    turns: { completed: 0, failed: 0, cancelled: 0 },
    prevTurns: { completed: 0, failed: 0, cancelled: 0 },
    members: [],
    now: NOW,
    ...overrides,
  };
}

function member(o: Partial<AttentionMember> = {}): AttentionMember {
  return {
    userId: "u1",
    name: "Alice",
    status: "active",
    monthCap: null,
    sharedSpend30d: 0,
    lastTurnAt: new Date(days(1)).toISOString(),
    createdAt: new Date(days(60)).toISOString(), // an established seat by default
    ...o,
  };
}

describe("failureRate", () => {
  it("excludes cancelled from the denominator", () => {
    // 2 failed of (6 completed + 2 failed) concluded = 0.25, cancelled ignored.
    expect(failureRate({ completed: 6, failed: 2 })).toBeCloseTo(0.25);
  });
  it("is zero when nothing concluded", () => {
    expect(failureRate({ completed: 0, failed: 0 })).toBe(0);
  });
});

describe("budget-overrun-projected", () => {
  it("fires when the 30-day projection exceeds the instance budget", () => {
    // $60 over 30 days → projects to $60/mo, budget $50 → overrun.
    const t = computeAttention(base({ spend: 60, days: 30, budgetMonthly: 50 }));
    expect(t).toContainEqual({ type: "budget-overrun-projected", projected: 60, budget: 50 });
  });
  it("does not fire when under budget", () => {
    const t = computeAttention(base({ spend: 30, days: 30, budgetMonthly: 50 }));
    expect(t.find((x) => x.type === "budget-overrun-projected")).toBeUndefined();
  });
  it("is absent when no budget is set", () => {
    const t = computeAttention(base({ spend: 9999, days: 30, budgetMonthly: null }));
    expect(t.find((x) => x.type === "budget-overrun-projected")).toBeUndefined();
  });
  it("never fires in the own-key view", () => {
    const t = computeAttention(base({ scope: "own", spend: 60, days: 30, budgetMonthly: 50 }));
    expect(t.find((x) => x.type === "budget-overrun-projected")).toBeUndefined();
  });
});

describe("member-near-budget", () => {
  it("fires past 80% of the effective monthly cap", () => {
    const t = computeAttention(base({ members: [member({ monthCap: 100, sharedSpend30d: 85 })] }));
    expect(t).toContainEqual({ type: "member-near-budget", userId: "u1", name: "Alice", used: 85, cap: 100, pct: 0.85 });
  });
  it("does not fire at exactly 80% or below", () => {
    const t = computeAttention(base({ members: [member({ monthCap: 100, sharedSpend30d: 80 })] }));
    expect(t.find((x) => x.type === "member-near-budget")).toBeUndefined();
  });
  it("ignores unlimited (null cap) members", () => {
    const t = computeAttention(base({ members: [member({ monthCap: null, sharedSpend30d: 9999 })] }));
    expect(t.find((x) => x.type === "member-near-budget")).toBeUndefined();
  });
  it("never fires in the own-key view", () => {
    const t = computeAttention(base({ scope: "own", members: [member({ monthCap: 100, sharedSpend30d: 85 })] }));
    expect(t.find((x) => x.type === "member-near-budget")).toBeUndefined();
  });
});

describe("failure-spike", () => {
  it("fires when volume, absolute, and relative thresholds all hold", () => {
    // 25 concluded, 5 failed = 20%; prev 2%. 20% ≥ 2%+5pp and ≥ 1.5×2%.
    const t = computeAttention(
      base({
        turns: { completed: 20, failed: 5, cancelled: 0 },
        prevTurns: { completed: 98, failed: 2, cancelled: 0 },
      }),
    );
    expect(t.find((x) => x.type === "failure-spike")).toMatchObject({ turns: 25 });
  });
  it("does not fire below the 20-turn volume gate", () => {
    const t = computeAttention(
      base({
        turns: { completed: 5, failed: 5, cancelled: 0 }, // 50% but only 10 turns
        prevTurns: { completed: 100, failed: 0, cancelled: 0 },
      }),
    );
    expect(t.find((x) => x.type === "failure-spike")).toBeUndefined();
  });
  it("does not fire when the absolute lift is under 5 p.p.", () => {
    const t = computeAttention(
      base({
        turns: { completed: 96, failed: 4, cancelled: 0 }, // 4%
        prevTurns: { completed: 99, failed: 1, cancelled: 0 }, // 1% → +3pp only
      }),
    );
    expect(t.find((x) => x.type === "failure-spike")).toBeUndefined();
  });
  it("counts cancelled toward the volume gate but not the rate", () => {
    // 8 completed + 2 failed concluded = 20% rate; 10 cancelled push volume to 20.
    const t = computeAttention(
      base({
        turns: { completed: 8, failed: 2, cancelled: 10 },
        prevTurns: { completed: 100, failed: 0, cancelled: 0 },
      }),
    );
    expect(t.find((x) => x.type === "failure-spike")).toMatchObject({ turns: 20 });
  });
});

describe("idle-seats", () => {
  it("flags active users with no turn in 14 days, and those who never ran one", () => {
    const t = computeAttention(
      base({
        members: [
          member({ userId: "a", name: "Anna", lastTurnAt: new Date(days(20)).toISOString() }),
          member({ userId: "b", name: "Bob", lastTurnAt: null }),
          member({ userId: "c", name: "Cara", lastTurnAt: new Date(days(2)).toISOString() }), // recent → not idle
        ],
      }),
    );
    const idle = t.find((x) => x.type === "idle-seats");
    expect(idle).toMatchObject({ type: "idle-seats", count: 2 });
    expect((idle as { names: string[] }).names).toEqual(["Anna", "Bob"]);
  });
  it("ignores non-active users", () => {
    const t = computeAttention(
      base({ members: [member({ status: "suspended", lastTurnAt: null })] }),
    );
    expect(t.find((x) => x.type === "idle-seats")).toBeUndefined();
  });
  it("does not flag a seat created within the idle window that has no turns yet", () => {
    // Invited 3 days ago, never ran a turn — too new to be idle.
    const t = computeAttention(
      base({ members: [member({ lastTurnAt: null, createdAt: new Date(days(3)).toISOString() })] }),
    );
    expect(t.find((x) => x.type === "idle-seats")).toBeUndefined();
  });
  it("flags an established seat that has never run a turn", () => {
    // Created 60 days ago, never ran a turn — a genuinely idle seat.
    const t = computeAttention(
      base({ members: [member({ lastTurnAt: null, createdAt: new Date(days(60)).toISOString() })] }),
    );
    expect(t.find((x) => x.type === "idle-seats")).toMatchObject({ count: 1 });
  });
  it("fires idle-seats even in the own-key view", () => {
    const t = computeAttention(
      base({ scope: "own", members: [member({ lastTurnAt: null })] }),
    );
    expect(t.find((x) => x.type === "idle-seats")).toBeDefined();
  });
});

it("returns an empty array when nothing is wrong", () => {
  expect(computeAttention(base())).toEqual([]);
});
