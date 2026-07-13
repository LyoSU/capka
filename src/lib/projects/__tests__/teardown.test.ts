import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];

const { destroySession } = vi.hoisted(() => ({ destroySession: vi.fn() }));
vi.mock("@/lib/sandbox/client", () => ({ destroySession }));
vi.mock("@/lib/log", () => ({ log: { info: () => {}, error: () => {} } }));

const h = vi.hoisted(() => {
  let selectRows: Record<string, unknown>[] = [];
  return {
    setSelectRows: (r: Record<string, unknown>[]) => { selectRows = r; },
    db: {
      delete: (tbl: unknown) => ({ where: () => { (globalThis as { __c?: string[] }).__c?.push(`delete:${String((tbl as { _?: unknown }) && "t")}`); return Promise.resolve(); } }),
      select: () => ({ from: () => ({ where: () => Promise.resolve(selectRows) }) }),
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

// Tables are referenced only as opaque markers in the mock; import after mocks.
import { teardownProject, retryPendingProjectTeardowns } from "@/lib/projects/teardown";

beforeEach(() => {
  calls.length = 0;
  (globalThis as { __c?: string[] }).__c = calls;
  destroySession.mockReset().mockImplementation(async () => { calls.push("destroySession"); });
  h.setSelectRows([]);
});

describe("teardownProject", () => {
  it("kills the sandbox, then removes the DB rows (idempotent order)", async () => {
    await teardownProject({ id: "p1", userId: "u1" });
    expect(destroySession).toHaveBeenCalledWith("p1", "u1");
    // destroySession runs before the physical row deletes.
    expect(calls[0]).toBe("destroySession");
    expect(calls.filter((c) => c.startsWith("delete:")).length).toBe(2); // folders + project
  });
});

describe("retryPendingProjectTeardowns", () => {
  it("re-drives teardown for each tombstoned project", async () => {
    h.setSelectRows([{ id: "p1", userId: "u1" }, { id: "p2", userId: "u1" }]);
    await retryPendingProjectTeardowns(0);
    expect(destroySession).toHaveBeenCalledTimes(2);
  });

  it("no-ops when nothing is tombstoned", async () => {
    h.setSelectRows([]);
    await retryPendingProjectTeardowns(0);
    expect(destroySession).not.toHaveBeenCalled();
  });
});
