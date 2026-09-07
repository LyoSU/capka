import { describe, it, expect, vi, beforeEach } from "vitest";
import { SandboxError } from "@/lib/errors";

// The move path must ABORT (not silently skip the file carry-over and switch
// projectId) when the workspace listing fails. These stubs let us drive listFiles
// into a throw and assert the chat's projectId is never written.
const { requireRole, requireOwned, isLiveProject, listFiles, copyWorkspace } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireOwned: vi.fn(),
  isLiveProject: vi.fn(),
  listFiles: vi.fn(),
  copyWorkspace: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole };
});
vi.mock("@/lib/db/ownership", () => ({ requireOwned }));
vi.mock("@/lib/projects/live", () => ({ isLiveProject }));
vi.mock("@/lib/sandbox/client", () => ({ listFiles, copyWorkspace }));
vi.mock("@/lib/log", () => ({ log: { info: () => {}, error: () => {} } }));

const h = vi.hoisted(() => {
  // The move path selects three times, in this order: the active-task count, the
  // chat's own attached_folders rows, then the folder names already taken in the
  // target project. Nothing here reads the WHERE clause, so the queue order IS the
  // contract — `rows` is refilled per test.
  const state = { rows: [] as unknown[][] };
  // Each update call pushes its `.set(...)` payload, so `sets[i]` is the payload
  // written to `tables[i]` — every `db.update(x)` here is followed by one `.set()`.
  const sets: unknown[] = [];
  // `table` is declared so the mock RECORDS it: a test tells the chats write from
  // the attached_folders one by the table `db.update(...)` was called with.
  const tables: unknown[] = [];
  const update = vi.fn((table?: unknown) => {
    tables.push(table);
    return {
      set: (values: unknown) => {
        sets.push(values);
        return { where: () => Promise.resolve() };
      },
    };
  });
  return {
    state,
    sets,
    tables,
    update,
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(state.rows.shift() ?? []) }) }),
      update,
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

import { PATCH } from "@/app/api/chats/[id]/route";
import { chats, attachedFolders } from "@/lib/db/schema";

const req = (body: unknown) => new Request("http://x/api/chats/c1", { method: "PATCH", body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "c1" }) };

beforeEach(() => {
  requireRole.mockReset().mockResolvedValue({ userId: "u1" });
  requireOwned.mockReset().mockResolvedValue({ id: "c1", projectId: null, title: "My chat" });
  isLiveProject.mockReset().mockResolvedValue(true);
  listFiles.mockReset();
  copyWorkspace.mockReset();
  h.update.mockClear();
  h.sets.length = 0;
  h.tables.length = 0;
  // Default: no live task, no attached folders on either side.
  h.state.rows = [[{ n: 0 }], [], []];
});

/** The table each `db.update(...)` call targeted, in call order. */
const updatedTables = () => h.tables;

describe("PATCH /api/chats/[id] move — listing failure aborts", () => {
  it("does not switch projectId when the workspace listing fails", async () => {
    listFiles.mockRejectedValue(new SandboxError("Sandbox operation failed", "list", true, 502));
    const res = await PATCH(req({ projectId: "p1" }), params);
    expect(res.status).toBe(502); // SandboxError surfaced, not swallowed
    expect(copyWorkspace).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled(); // projectId never written
  });

  it("copies files then allows the switch when the listing succeeds", async () => {
    listFiles.mockResolvedValue({ entries: [{ name: "report.txt" }] });
    copyWorkspace.mockResolvedValue(undefined);
    const res = await PATCH(req({ projectId: "p1" }), params);
    expect(res.status).toBe(200);
    expect(copyWorkspace).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1); // projectId written after copy
  });
});

describe("PATCH /api/chats/[id] move — attached folders follow the chat", () => {
  it("re-keys the chat's folders onto the project session key", async () => {
    listFiles.mockResolvedValue({ entries: [] });                 // nothing to copy
    h.state.rows = [[{ n: 0 }], [{ id: "f1", name: "reports" }], []];

    const res = await PATCH(req({ projectId: "p1" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("foldersNotCarried");

    const i = updatedTables().indexOf(attachedFolders);
    expect(i).toBeGreaterThanOrEqual(0);                          // the folder row was written
    expect(h.sets[i]).toMatchObject({ sessionKey: "p1" });        // onto the project's key
    expect(updatedTables()).toContain(chats);                     // and the move still happened
  });

  it("leaves a folder behind and names it when the project already has that name", async () => {
    listFiles.mockResolvedValue({ entries: [] });
    h.state.rows = [[{ n: 0 }], [{ id: "f1", name: "reports" }], [{ name: "reports" }]];

    const res = await PATCH(req({ projectId: "p1" }), params);
    expect(res.status).toBe(200);                                 // the move is NOT failed
    expect(await res.json()).toMatchObject({ ok: true, foldersNotCarried: ["reports"] });
    expect(updatedTables()).not.toContain(attachedFolders);       // the row stays on the chat
    expect(updatedTables()).toContain(chats);
  });

  it("does not pull a project's folders away when a chat leaves it", async () => {
    // Project → none (and project → project) must not touch attached_folders: the
    // rows belong to the project and are shared by every chat still in it.
    requireOwned.mockResolvedValue({ id: "c1", projectId: "p1", title: "My chat" });
    h.state.rows = [[{ n: 0 }], [{ id: "f1", name: "reports" }], []];

    const res = await PATCH(req({ projectId: null }), params);
    expect(res.status).toBe(200);
    expect(listFiles).not.toHaveBeenCalled();                     // no carry-over either
    expect(updatedTables()).not.toContain(attachedFolders);
  });
});
