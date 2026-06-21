import { describe, it, expect, vi } from "vitest";
import { gcOrphanWorkspaces, findOverQuota } from "./gc.js";

describe("gcOrphanWorkspaces", () => {
  it("removes orphaned workspaces older than grace", async () => {
    const store = { all: async () => [{ sessionId: "live" }] };
    const remove = vi.fn();
    const listOnDisk = async () => [
      { userId: "u1", sessionId: "live", mtimeMs: 0 },
      { userId: "u1", sessionId: "dead", mtimeMs: 0 },
    ];
    await gcOrphanWorkspaces({ store, workspace: { remove }, listOnDisk, graceMs: 1000, now: 10_000 });
    expect(remove).toHaveBeenCalledWith("u1", "dead");
    expect(remove).not.toHaveBeenCalledWith("u1", "live");
  });

  it("keeps young orphans within grace", async () => {
    const store = { all: async () => [] };
    const remove = vi.fn();
    const listOnDisk = async () => [{ userId: "u1", sessionId: "new", mtimeMs: 9_500 }];
    await gcOrphanWorkspaces({ store, workspace: { remove }, listOnDisk, graceMs: 1000, now: 10_000 });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("findOverQuota", () => {
  const store = { all: async () => [
    { sessionId: "small", userId: "u1" },
    { sessionId: "big", userId: "u2" },
  ] };
  const workspace = { size: async (_u, sid) => (sid === "big" ? 600 : 100) };

  it("reports only sessions exceeding the limit (reporting, not destroying)", async () => {
    const over = await findOverQuota({ store, workspace, limitBytes: 500 });
    expect(over).toEqual([{ sessionId: "big", userId: "u2", bytes: 600 }]);
  });

  it("returns nothing when all workspaces are under the limit", async () => {
    expect(await findOverQuota({ store, workspace, limitBytes: 1000 })).toEqual([]);
  });
});
