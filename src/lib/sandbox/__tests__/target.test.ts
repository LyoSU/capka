import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundError, ValidationError } from "@/lib/errors";

// Mock ownership (chat lookup) and db (project lookup). The project query's
// where-clause (userId + deleted_at is null) is not re-executed by the fake db, so
// the test drives "found / foreign / tombstoned" purely by what rows it returns.
const { requireOwned } = vi.hoisted(() => ({ requireOwned: vi.fn() }));
vi.mock("@/lib/db/ownership", () => ({ requireOwned }));

const h = vi.hoisted(() => {
  let rows: Record<string, unknown>[] = [];
  const thenable = (): unknown => {
    const p = Promise.resolve(rows);
    return Object.assign(p, { where: () => thenable(), limit: () => Promise.resolve(rows) });
  };
  return {
    setRows: (r: Record<string, unknown>[]) => { rows = r; },
    db: { select: () => ({ from: () => thenable() }) },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

import { resolveWorkspaceTarget } from "@/lib/sandbox/target";

beforeEach(() => {
  h.setRows([]);
  requireOwned.mockReset();
});

describe("resolveWorkspaceTarget", () => {
  it("rejects both chatId and projectId together (400)", async () => {
    await expect(
      resolveWorkspaceTarget({ userId: "u1", chatId: "c1", projectId: "p1" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects neither chatId nor projectId (400)", async () => {
    await expect(resolveWorkspaceTarget({ userId: "u1" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("resolves a project target to the project id as the session key", async () => {
    h.setRows([{ id: "p1" }]);
    const r = await resolveWorkspaceTarget({ userId: "u1", projectId: "p1" });
    expect(r).toEqual({ sessionKey: "p1", projectId: "p1", ownerId: "u1" });
  });

  it("404s a foreign or tombstoned project (query returns no row)", async () => {
    h.setRows([]);
    await expect(
      resolveWorkspaceTarget({ userId: "u1", projectId: "p-gone" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resolves a chat with a project to the shared project key", async () => {
    requireOwned.mockResolvedValue({ id: "c1", projectId: "p9" });
    const r = await resolveWorkspaceTarget({ userId: "u1", chatId: "c1" });
    expect(r).toEqual({ sessionKey: "p9", projectId: "p9", ownerId: "u1" });
  });

  it("resolves a standalone chat to its own key", async () => {
    requireOwned.mockResolvedValue({ id: "c1", projectId: null });
    const r = await resolveWorkspaceTarget({ userId: "u1", chatId: "c1" });
    expect(r).toEqual({ sessionKey: "c1", projectId: null, ownerId: "u1" });
  });

  it("404s a foreign chat (requireOwned throws)", async () => {
    requireOwned.mockRejectedValue(new NotFoundError("Chat"));
    await expect(
      resolveWorkspaceTarget({ userId: "u1", chatId: "c-foreign" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
