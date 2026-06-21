import { describe, it, expect, vi } from "vitest";
import { gcOrphanWorkspaces } from "./gc.js";

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
