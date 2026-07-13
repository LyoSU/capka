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
  const update = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) }));
  return {
    update,
    db: {
      // The only select in the move path is the active-task count → no live task.
      select: () => ({ from: () => ({ where: () => Promise.resolve([{ n: 0 }]) }) }),
      update,
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

import { PATCH } from "@/app/api/chats/[id]/route";

const req = (body: unknown) => new Request("http://x/api/chats/c1", { method: "PATCH", body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "c1" }) };

beforeEach(() => {
  requireRole.mockReset().mockResolvedValue({ userId: "u1" });
  requireOwned.mockReset().mockResolvedValue({ id: "c1", projectId: null, title: "My chat" });
  isLiveProject.mockReset().mockResolvedValue(true);
  listFiles.mockReset();
  copyWorkspace.mockReset();
  h.update.mockClear();
});

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
