import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireRole, requireSession } = vi.hoisted(() => ({ requireRole: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole, requireSession };
});

vi.mock("@/lib/crypto", () => ({
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ""),
}));
const { ownKeysAllowed } = vi.hoisted(() => ({ ownKeysAllowed: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getMasterKey: async () => "mk", ownKeysAllowed }));
vi.mock("@/lib/providers", () => ({ PROVIDERS: ["openai"] }));
const { invalidateModelsCache } = vi.hoisted(() => ({ invalidateModelsCache: vi.fn() }));
vi.mock("@/lib/providers/list-models", () => ({ invalidateModelsCache }));

const h = vi.hoisted(() => {
  const state = { set: null as Record<string, unknown> | null, found: true, rows: [] as unknown[] };
  return {
    state,
    db: {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(state.rows) }) }) }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          state.set = v;
          return {
            where: () => ({
              returning: () => Promise.resolve(state.found ? [{ id: "a", defaultModel: null, label: v.label ?? null, iconSlug: null }] : []),
            }),
          };
        },
      }),
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

import { GET, PUT } from "@/app/api/settings/providers/route";

const put = (body: unknown) => new Request("http://x/api/settings/providers", { method: "PUT", body: JSON.stringify(body) });

beforeEach(() => {
  h.state.set = null;
  h.state.found = true;
  ownKeysAllowed.mockReset().mockResolvedValue(true);
  invalidateModelsCache.mockReset();
  requireRole.mockReset().mockResolvedValue({ userId: "u1", role: "admin" });
  requireSession.mockReset().mockResolvedValue({ userId: "u1", role: "admin" });
});

describe("PUT /api/settings/providers — rename and edit", () => {
  it("renames without touching credentials", async () => {
    const r = await PUT(put({ id: "a", label: "  OpenRouter - work " }));
    expect(r.status).toBe(200);
    expect(h.state.set).toEqual({ label: "OpenRouter - work" });
    expect(invalidateModelsCache).toHaveBeenCalledOnce();
  });

  it("keeps the stored key when the key is empty or absent", async () => {
    await PUT(put({ id: "a", apiKey: "", baseUrl: "https://x.test/v1" }));
    expect(h.state.set).toEqual({ baseUrl: "https://x.test/v1" });
  });

  it("replaces the key (encrypted) when one is typed", async () => {
    await PUT(put({ id: "a", apiKey: " sk-new " }));
    expect(h.state.set).toEqual({ apiKey: "enc(sk-new)" });
  });

  it("clears the base URL with an empty string", async () => {
    await PUT(put({ id: "a", baseUrl: "" }));
    expect(h.state.set).toEqual({ baseUrl: null });
  });

  it("rejects a malformed base URL without writing", async () => {
    const r = await PUT(put({ id: "a", baseUrl: "ftp://nope" }));
    expect(r.status).toBe(400);
    expect(h.state.set).toBeNull();
  });

  it("404s for a connection the caller does not own", async () => {
    h.state.found = false;
    expect((await PUT(put({ id: "zzz", label: "x" }))).status).toBe(404);
  });

  it("403s a non-admin changing credentials when own keys are disabled", async () => {
    requireRole.mockResolvedValue({ userId: "u2", role: "user" });
    ownKeysAllowed.mockResolvedValue(false);
    const r = await PUT(put({ id: "a", apiKey: "sk-x" }));
    expect(r.status).toBe(403);
    expect(h.state.set).toBeNull();
  });
});

describe("GET /api/settings/providers", () => {
  it("never returns the stored key, only a last-four hint", async () => {
    h.state.rows = [
      { id: "a", provider: "openai", apiKey: "enc(sk-secret1234)", label: null },
      { id: "b", provider: "ollama", apiKey: null, label: null },
    ];
    const body = await (await GET()).json();
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body[0]).toMatchObject({ hasKey: true, keyHint: "1234" });
    expect(body[1]).toMatchObject({ hasKey: false, keyHint: null });
    expect(body[0]).not.toHaveProperty("apiKey");
  });
});
