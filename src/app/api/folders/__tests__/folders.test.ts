import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundError } from "@/lib/errors";

// Stub the auth gate + the folder-access level + ownership; keep apiHandler and the
// real error classes so thrown AppErrors map to their status codes.
const { requireActive, pcFolderLevel, requireOwned } = vi.hoisted(() => ({
  requireActive: vi.fn(),
  pcFolderLevel: vi.fn(),
  requireOwned: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireActive };
});
vi.mock("@/lib/manage/controls/folders", () => ({
  pcFolderLevel,
  // Pure predicate — use the real logic so the route's gate is exercised.
  canAttachPc: (level: string, isAdmin: boolean) => level === "everyone" || (level === "admins" && isAdmin),
}));
vi.mock("@/lib/db/ownership", () => ({ requireOwned }));

const h = vi.hoisted(() => {
  let rows: Record<string, unknown>[] = [];
  const thenable = (getter: () => Record<string, unknown>[]): unknown => {
    const p = Promise.resolve().then(getter);
    return Object.assign(p, { where: () => thenable(getter), limit: (n: number) => Promise.resolve(getter().slice(0, n)) });
  };
  return {
    setRows: (r: Record<string, unknown>[]) => { rows = r; },
    getRows: () => rows,
    db: {
      select: () => ({ from: () => thenable(() => rows.map((r) => ({ ...r }))) }),
      insert: () => ({ values: (v: Record<string, unknown>) => { rows.push({ ...v }); return Promise.resolve(); } }),
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
      delete: () => ({ where: () => { rows = []; return Promise.resolve(); } }),
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

import { GET, POST } from "@/app/api/folders/route";
import { DELETE } from "@/app/api/folders/[id]/route";

const jsonReq = (url: string, method: string, body?: unknown) =>
  new Request(url, { method, body: body ? JSON.stringify(body) : undefined });

beforeEach(() => {
  h.setRows([]);
  requireActive.mockReset().mockResolvedValue({ userId: "u1", role: "user", status: "active" });
  pcFolderLevel.mockReset().mockResolvedValue("everyone");
  requireOwned.mockReset().mockResolvedValue({ id: "c1", projectId: null });
});

describe("POST /api/folders — pc folder create", () => {
  it("403 when folder access is off", async () => {
    pcFolderLevel.mockResolvedValue("off");
    const r = await POST(jsonReq("http://x/api/folders", "POST", { chatId: "c1", name: "docs" }));
    expect(r.status).toBe(403);
  });

  it("403 for a non-admin when access is admins-only", async () => {
    pcFolderLevel.mockResolvedValue("admins");
    const r = await POST(jsonReq("http://x/api/folders", "POST", { chatId: "c1", name: "docs" }));
    expect(r.status).toBe(403);
  });

  it("404 when the chat isn't the caller's (ownership check)", async () => {
    requireOwned.mockRejectedValue(new NotFoundError("Chat not found"));
    const r = await POST(jsonReq("http://x/api/folders", "POST", { chatId: "c1", name: "docs" }));
    expect(r.status).toBe(404);
  });

  it("creates a read-write pc row and returns it", async () => {
    const r = await POST(jsonReq("http://x/api/folders", "POST", { chatId: "c1", name: "My Docs" }));
    expect(r.status).toBe(201);
    expect((await r.json()).folder).toMatchObject({ kind: "pc", name: "mydocs", readOnly: false });
    expect(h.getRows()[0]).toMatchObject({ kind: "pc", name: "mydocs", userId: "u1" });
  });

  it("409 on a duplicate name in the same session", async () => {
    h.setRows([{ name: "docs", sessionKey: "c1" }]);
    const r = await POST(jsonReq("http://x/api/folders", "POST", { chatId: "c1", name: "docs" }));
    expect(r.status).toBe(409);
  });
});

describe("GET /api/folders", () => {
  it("400 without a chatId", async () => {
    const r = await GET(jsonReq("http://x/api/folders", "GET"));
    expect(r.status).toBe(400);
  });
  it("lists folders for the session", async () => {
    h.setRows([{ id: "f1", kind: "pc", name: "docs", readOnly: false, sessionKey: "c1" }]);
    const r = await GET(jsonReq("http://x/api/folders?chatId=c1", "GET"));
    expect((await r.json()).folders).toEqual([{ id: "f1", kind: "pc", name: "docs", readOnly: false }]);
  });
});

describe("DELETE /api/folders/[id]", () => {
  it("404 for a host row (removed via manage, not this route)", async () => {
    h.setRows([{ id: "f1", kind: "host", userId: "u1", sessionKey: "c1" }]);
    const r = await DELETE(jsonReq("http://x/api/folders/f1", "DELETE"), { params: Promise.resolve({ id: "f1" }) });
    expect(r.status).toBe(404);
  });
  it("404 for a pc row owned by someone else", async () => {
    h.setRows([{ id: "f1", kind: "pc", userId: "other", sessionKey: "c1" }]);
    const r = await DELETE(jsonReq("http://x/api/folders/f1", "DELETE"), { params: Promise.resolve({ id: "f1" }) });
    expect(r.status).toBe(404);
  });
  it("deletes the caller's pc row", async () => {
    h.setRows([{ id: "f1", kind: "pc", userId: "u1", sessionKey: "c1" }]);
    const r = await DELETE(jsonReq("http://x/api/folders/f1", "DELETE"), { params: Promise.resolve({ id: "f1" }) });
    expect(r.status).toBe(200);
    expect(h.getRows()).toHaveLength(0);
  });
});
