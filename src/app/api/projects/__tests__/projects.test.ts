import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub auth (keep apiHandler + real error/Zod mapping) and the DB. These tests
// exercise the shared-schema validation the routes enforce, not the DB itself.
const { requireRole } = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole };
});

const h = vi.hoisted(() => {
  let projectRow: Record<string, unknown> | null = { id: "p1", userId: "u1", name: "P", deletedAt: null };
  const selectChain = (): unknown => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(projectRow ? [projectRow] : []) }),
    }),
  });
  return {
    setProjectRow: (r: Record<string, unknown> | null) => { projectRow = r; },
    db: {
      select: () => selectChain(),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "new", name: "ok" }]) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: "p1" }]) }) }) }),
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

import { POST } from "@/app/api/projects/route";
import { PUT } from "@/app/api/projects/[id]/route";

const jsonReq = (method: string, body: unknown) =>
  new Request("http://x/api/projects", { method, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  requireRole.mockReset().mockResolvedValue({ userId: "u1", role: "user" });
  h.setProjectRow({ id: "p1", userId: "u1", name: "P", deletedAt: null });
});

describe("POST /api/projects validation", () => {
  it("400s a whitespace-only name", async () => {
    const r = await POST(jsonReq("POST", { name: "   " }));
    expect(r.status).toBe(400);
  });

  it("400s a name over the length limit", async () => {
    const r = await POST(jsonReq("POST", { name: "a".repeat(201) }));
    expect(r.status).toBe(400);
  });

  it("creates with a valid name", async () => {
    const r = await POST(jsonReq("POST", { name: "  Real  " }));
    expect(r.status).toBe(201);
  });
});

describe("PUT /api/projects/[id] validation", () => {
  it("400s a non-string name", async () => {
    const r = await PUT(jsonReq("PUT", { name: 123 }), params("p1"));
    expect(r.status).toBe(400);
  });

  it("404s a tombstoned/foreign project", async () => {
    h.setProjectRow(null);
    const r = await PUT(jsonReq("PUT", { name: "New" }), params("p1"));
    expect(r.status).toBe(404);
  });

  it("updates with a valid partial body", async () => {
    const r = await PUT(jsonReq("PUT", { description: "hi" }), params("p1"));
    expect(r.status).toBe(200);
  });
});
