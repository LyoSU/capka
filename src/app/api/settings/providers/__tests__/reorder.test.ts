import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the auth gate; keep apiHandler + the real error classes so any thrown
// AppError still maps to its status code.
const { requireRole } = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole };
});

// Minimal stubs for modules the route imports for its OTHER branches, so the
// reorder path under test doesn't drag in the provider SDK / crypto.
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getMasterKey: vi.fn(), ownKeysAllowed: vi.fn() }));
vi.mock("@/lib/providers", () => ({ PROVIDERS: ["openai"] }));
const { invalidateModelsCache } = vi.hoisted(() => ({ invalidateModelsCache: vi.fn() }));
vi.mock("@/lib/providers/list-models", () => ({ invalidateModelsCache }));

const h = vi.hoisted(() => {
  let owned: { id: string }[] = [];
  const state = { txCalls: 0, updateCalls: 0 };
  return {
    setOwned: (ids: string[]) => { owned = ids.map((id) => ({ id })); },
    state,
    reset: () => { state.txCalls = 0; state.updateCalls = 0; },
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(owned.map((r) => ({ ...r }))) }) }),
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
        state.txCalls++;
        const tx = {
          update: () => {
            state.updateCalls++;
            return { set: () => ({ where: () => Promise.resolve() }) };
          },
        };
        return cb(tx);
      },
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

import { PUT } from "@/app/api/settings/providers/route";

const req = (body: unknown) =>
  new Request("http://x/api/settings/providers", {
    method: "PUT",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.reset();
  invalidateModelsCache.mockReset();
  requireRole.mockReset().mockResolvedValue({ userId: "u1", role: "user" });
  h.setOwned(["a", "b", "c"]);
});

describe("PUT /api/settings/providers — reorder", () => {
  it("reorders a full, owned permutation", async () => {
    const r = await PUT(req({ order: ["c", "a", "b"] }));
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toEqual({ ok: true });
    expect(h.state.txCalls).toBe(1);
    expect(h.state.updateCalls).toBe(3); // one write per connection
    expect(invalidateModelsCache).toHaveBeenCalledOnce();
  });

  it("rejects an id the caller doesn't own — no writes", async () => {
    const r = await PUT(req({ order: ["a", "b", "x"] }));
    expect(r.status).toBe(400);
    expect(h.state.txCalls).toBe(0);
    expect(invalidateModelsCache).not.toHaveBeenCalled();
  });

  it("rejects a partial order that omits a connection", async () => {
    const r = await PUT(req({ order: ["a", "b"] }));
    expect(r.status).toBe(400);
    expect(h.state.txCalls).toBe(0);
  });

  it("rejects duplicate ids", async () => {
    const r = await PUT(req({ order: ["a", "b", "b"] }));
    expect(r.status).toBe(400);
    expect(h.state.txCalls).toBe(0);
  });

  it("rejects a non-string entry", async () => {
    const r = await PUT(req({ order: ["a", "b", 3] }));
    expect(r.status).toBe(400);
    expect(h.state.txCalls).toBe(0);
  });
});
