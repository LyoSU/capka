import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The budget widget's visibility must be decided by the SAME question the
 * enforcement gate asks: "can this person spend on the shared key at all?"
 *
 * /api/chat resolves that per turn from the config owning the CHOSEN model
 * (resolveUserModelInfo), while this route used to read it off the user's
 * DEFAULT config (resolveProviderConfig → first of resolveEnabledConfigs, own
 * always first). A user with one own key therefore reported onSharedKey:false
 * and the widget rendered nothing — while their turns on the admin's shared
 * models were still held, still capped, and still able to fail with
 * BudgetExceededError against an invisible meter.
 */
const { requireSession, resolveEnabledConfigs, getLimitStatus, getProviderKeyMode, ownKeysAllowed } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  resolveEnabledConfigs: vi.fn(),
  getLimitStatus: vi.fn(),
  getProviderKeyMode: vi.fn(),
  ownKeysAllowed: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession };
});
vi.mock("@/lib/providers/resolve", () => ({ resolveEnabledConfigs }));
vi.mock("@/lib/billing/limits", () => ({ getLimitStatus }));
vi.mock("@/lib/settings", () => ({ getProviderKeyMode, ownKeysAllowed }));

const turnRows = vi.hoisted(() => ({ value: [{ n: 0 }] as { n: number }[] }));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(turnRows.value) }),
    }),
  },
}));

import { GET } from "@/app/api/me/billing/route";

// The handler declares no params, but apiHandler's catch reads args[0] as the
// Request (Next passes it at runtime) — hand one over so an unexpected throw
// reports as a 500 here too, instead of dying inside the error path.
const get = () => (GET as (req: Request) => Promise<Response>)(new Request("http://x/api/me/billing"));

const status = (blocked = false) => ({
  tierId: "default",
  tierName: "Default",
  windows: [
    { window: "h5" as const, committed: 1, reserved: 0, used: 1, limit: 10, pct: 10 },
    { window: "d7" as const, committed: 1, reserved: 0, used: 1, limit: null, pct: 0 },
    { window: "m1" as const, committed: 1, reserved: 0, used: 1, limit: null, pct: 0 },
  ],
  blocked,
  blockedWindow: null,
});

beforeEach(() => {
  turnRows.value = [{ n: 3 }];
  requireSession.mockReset().mockResolvedValue({ userId: "u1" });
  getProviderKeyMode.mockReset().mockResolvedValue("shared_plus_own");
  ownKeysAllowed.mockReset().mockResolvedValue(true);
  getLimitStatus.mockReset().mockResolvedValue(status());
  resolveEnabledConfigs.mockReset().mockResolvedValue([]);
});

describe("GET /api/me/billing — shared-key exposure", () => {
  it("reports the shared key for a user whose OWN config sorts first", async () => {
    // The shape resolveEnabledConfigs returns in shared_plus_own once the user
    // adds a personal key: own first, admin's shared appended after it.
    resolveEnabledConfigs.mockResolvedValue([
      { id: "own1", isShared: false },
      { id: "adminShared", isShared: true },
    ]);

    const body = await (await get()).json();

    expect(body.onSharedKey).toBe(true);
    expect(body.limits).not.toBeNull();
    expect(getLimitStatus).toHaveBeenCalledWith("u1");
  });

  it("reports the shared key for a user with no key of their own", async () => {
    resolveEnabledConfigs.mockResolvedValue([{ id: "adminShared", isShared: true }]);

    const body = await (await get()).json();

    expect(body.onSharedKey).toBe(true);
    expect(body.limits).not.toBeNull();
  });

  it("does not report the shared key when nothing shared is reachable", async () => {
    // own_only, or an admin whose own configs are never 'shared' to themselves —
    // no shared-key spend is possible, so no budget applies.
    resolveEnabledConfigs.mockResolvedValue([{ id: "own1", isShared: false }]);

    const body = await (await get()).json();

    expect(body.onSharedKey).toBe(false);
    expect(body.limits).toBeNull();
    expect(getLimitStatus).not.toHaveBeenCalled();
  });

  it("returns a turn count even when the user has run nothing", async () => {
    resolveEnabledConfigs.mockResolvedValue([{ id: "adminShared", isShared: true }]);
    turnRows.value = [{ n: 0 }];

    const body = await (await get()).json();

    expect(body.turns30d).toBe(0);
  });
});
