import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

// The chat panel's ⋯ menu reads one chat row by id — a new way into a record that
// until now only ever arrived inside the owner's own list. So what is pinned here
// is the gate, not the shape: a signed-out caller is refused, someone else's chat
// is a 404 (never a 403, which would confirm the id exists), and the body carries
// only the fields the menu acts on.
const { requireRole, requireOwned } = vi.hoisted(() => ({ requireRole: vi.fn(), requireOwned: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole };
});
vi.mock("@/lib/db/ownership", () => ({ requireOwned }));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));
vi.mock("@/lib/sandbox/client", () => ({ listFiles: vi.fn(), copyWorkspace: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { info: () => {}, error: () => {} } }));

import { GET } from "@/app/api/chats/[id]/route";

const params = Promise.resolve({ id: "c1" });
const get = () => GET(new Request("http://x/api/chats/c1"), { params });

beforeEach(() => {
  requireRole.mockReset();
  requireOwned.mockReset();
});

describe("GET /api/chats/[id]", () => {
  it("refuses a caller the role gate rejects, before any row is read", async () => {
    requireRole.mockImplementation(() => Promise.reject(new ForbiddenError("Your account is awaiting administrator approval.")));
    expect((await get()).status).toBe(403);
    expect(requireOwned).not.toHaveBeenCalled();
  });

  it("someone else's chat is a 404, not a 403", async () => {
    requireRole.mockResolvedValue({ userId: "u1", role: "user" });
    requireOwned.mockImplementation(() => Promise.reject(new NotFoundError("Chat")));
    expect((await get()).status).toBe(404);
    // The ownership check is the caller's own id, not one taken from the request.
    expect(requireOwned.mock.calls[0][2]).toBe("u1");
  });

  it("returns the owner's row as the fields the menu acts on, and nothing else", async () => {
    requireRole.mockResolvedValue({ userId: "u1", role: "user" });
    requireOwned.mockResolvedValue({
      id: "c1",
      userId: "u1",
      title: "Quarterly report",
      pinned: true,
      archived: null,
      projectId: null,
      visibility: "private",
      shareToken: null,
      // Present on the row, deliberately absent from the response.
      thinkAmount: "high",
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: "c1",
      title: "Quarterly report",
      pinned: true,
      archived: false,
      projectId: null,
      visibility: "private",
      shareToken: null,
    });
    expect(Object.keys(body)).not.toContain("userId");
    expect(Object.keys(body)).not.toContain("thinkAmount");
  });
});
