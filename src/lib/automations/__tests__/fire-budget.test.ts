import { describe, it, expect, vi, beforeEach } from "vitest";
import { BudgetExceededError } from "@/lib/errors";
import type { AutomationRow } from "../runs";

// A budget refusal used to come back as a bare `{ fired: false }`, which "Run now"
// reported as "the previous run is still going". A person pressing it is now told
// they are over their limit (429) and the click does not count toward the
// auto-disable; an unattended firing still counts, and says why.
const h = vi.hoisted(() => ({
  reserveBudget: vi.fn(),
  update: vi.fn(),
  localeError: undefined as Error | undefined,
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => (h.localeError ? Promise.reject(h.localeError) : Promise.resolve([{ locale: "en" }])) }),
    }),
    // recordAutomationOutcome's streak bump; no row back, so it stops there.
    update: (...a: unknown[]) => {
      h.update(...a);
      return { set: () => ({ where: () => ({ returning: async () => [] }) }) };
    },
  },
}));
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({ isShared: true, modelId: "m", provider: "p", configId: "cfg" }),
}));
vi.mock("@/lib/billing/limits", () => ({ reserveBudget: h.reserveBudget, releaseHold: vi.fn() }));
vi.mock("@/lib/tasks/queue", () => ({ enqueueTask: vi.fn(), notifyTaskEnqueued: vi.fn() }));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent: vi.fn() }));
vi.mock("../run-when", () => ({ evaluateRunWhen: vi.fn() }));

const { fireAutomation } = await import("../runs");

// No previous run and no condition, so the budget gate is the first thing it meets.
const row = {
  id: "a1", userId: "u1", title: "Report", prompt: "go", model: null, projectId: null,
  threadMode: "fresh", lastTaskId: null, runWhen: null, maxRunsPerDay: null,
  trigger: { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" },
} as unknown as AutomationRow;

beforeEach(() => {
  h.localeError = undefined;
  h.update.mockReset();
  h.reserveBudget.mockReset().mockResolvedValue({ allowed: false, window: "h5", reason: "budget" });
});

describe("fireAutomation budget refusal", () => {
  it("tells a person who pressed Run now, and does not count it toward the auto-disable", async () => {
    await expect(fireAutomation(row, { manual: true })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("an unattended firing says budget and counts toward the streak", async () => {
    expect(await fireAutomation(row)).toEqual({ fired: false, reason: "budget" });
    expect(h.update).toHaveBeenCalled();
  });

  // The locale used to be read after the reservation, outside anything that would
  // release it: a throw there stranded the hold until the orphan sweep.
  it("reserves nothing when the owner's locale cannot be read", async () => {
    h.reserveBudget.mockResolvedValue({ allowed: true, window: null, reason: null });
    h.localeError = new Error("db down");
    await expect(fireAutomation(row)).rejects.toThrow("db down");
    expect(h.reserveBudget).not.toHaveBeenCalled();
  });
});
