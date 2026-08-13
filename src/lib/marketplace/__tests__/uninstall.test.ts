import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Removing a plugin's rows must go through the skills/connectors services, because
 * a service owns the inverse of what its upsert installed beyond the row itself —
 * `deleteServer` also drops the connector's cached tool schemas. A bulk
 * `db.delete(mcpServers)` here leaves that cache holding an entry for a connector
 * that no longer exists, and an upgrade prunes on every upstream removal.
 *
 * The regression is invisible in the DB (the rows do go), so these tests assert the
 * ROUTING: which functions were called, and that the only table deleted directly is
 * the install row itself.
 */
const { deleteServer, deleteSkill, selectQueue, deletedTables } = vi.hoisted(() => ({
  deleteServer: vi.fn<(id: string) => Promise<void>>(),
  deleteSkill: vi.fn<(id: string) => Promise<void>>(),
  selectQueue: [] as unknown[][],
  deletedTables: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(selectQueue.shift() ?? []) }) }),
    delete: (table: unknown) => ({ where: () => { deletedTables.push(table); return Promise.resolve(); } }),
  },
}));
vi.mock("@/lib/mcp/service", () => ({
  deleteServer, upsertServer: vi.fn(), upsertStdioServer: vi.fn(), setEnabled: vi.fn(),
}));
vi.mock("@/lib/skills/service", () => ({ deleteSkill, ingestSkill: vi.fn() }));

import { pluginInstalls } from "@/lib/db/schema";
import { pruneRemoved, uninstallPlugin } from "../install";

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  deletedTables.length = 0;
});

describe("uninstallPlugin", () => {
  it("deletes the plugin's skills and connectors through their services", async () => {
    selectQueue.push([{ id: "sk1", name: "writer" }], [{ id: "srv1", name: "github" }, { id: "srv2", name: "jira" }]);

    await uninstallPlugin("inst1");

    expect(deleteSkill.mock.calls.map((c) => c[0])).toEqual(["sk1"]);
    expect(deleteServer.mock.calls.map((c) => c[0])).toEqual(["srv1", "srv2"]);
  });

  it("issues no bulk delete of its own beyond the install row", async () => {
    // This is the anti-regression: re-adding `db.delete(mcpServers)` here fails it,
    // even though the rows would still disappear.
    selectQueue.push([{ id: "sk1", name: "writer" }], [{ id: "srv1", name: "github" }]);

    await uninstallPlugin("inst1");

    expect(deletedTables).toEqual([pluginInstalls]);
  });
});

describe("pruneRemoved", () => {
  it("drops only what the new manifest no longer names", async () => {
    selectQueue.push(
      [{ id: "sk1", name: "kept" }, { id: "sk2", name: "gone" }],
      [{ id: "srv1", name: "kept-srv" }, { id: "srv2", name: "gone-srv" }],
    );

    await pruneRemoved("catalog:inst1", new Set(["kept"]), new Set(["kept-srv"]));

    expect(deleteSkill.mock.calls.map((c) => c[0])).toEqual(["sk2"]);
    expect(deleteServer.mock.calls.map((c) => c[0])).toEqual(["srv2"]);
  });

  it("keeps everything when the manifest still names it all (an upgrade that removed nothing)", async () => {
    selectQueue.push([{ id: "sk1", name: "writer" }], [{ id: "srv1", name: "github" }]);

    await pruneRemoved("catalog:inst1", new Set(["writer"]), new Set(["github"]));

    expect(deleteSkill).not.toHaveBeenCalled();
    expect(deleteServer).not.toHaveBeenCalled();
    expect(deletedTables).toEqual([]);
  });
});
