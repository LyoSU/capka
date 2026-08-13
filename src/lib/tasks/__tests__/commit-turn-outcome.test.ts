import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `commitTurnOutcome` is the single decision point for who owns a turn's outcome.
 * The SQL predicate itself needs Postgres (see queue.integration.test.ts for the
 * real reconcileZombies race); what is checked here is the shape around it, which is
 * where a regression would be silent: that a lost CAS rolls back and writes NO
 * message, and that the client is always returned to the pool.
 */
const { client, connect } = vi.hoisted(() => {
  const client = { query: vi.fn(), release: vi.fn() };
  return { client, connect: vi.fn(async () => client) };
});

vi.mock("@/lib/db", () => ({ pool: { connect, query: vi.fn() } }));
vi.mock("@/lib/realtime", () => ({ realtime: { publish: vi.fn(), subscribe: vi.fn() } }));

import { commitTurnOutcome } from "../queue";

const input = {
  taskId: "task-1",
  workerId: "worker-1",
  status: "completed" as const,
  error: null,
  message: { id: "msg-1", content: "the answer", metadata: { taskId: "task-1", status: "completed" } },
};

/** The statements issued, reduced to their first line for readable assertions. */
const statements = () => client.query.mock.calls.map((c) => String(c[0]).trim().split("\n")[0].trim());

beforeEach(() => {
  vi.clearAllMocks();
  client.query.mockResolvedValue({ rowCount: 1 });
});

describe("commitTurnOutcome", () => {
  it("writes the task and the message in one committed transaction when it wins", async () => {
    await expect(commitTurnOutcome(input)).resolves.toBe(true);

    const sql = statements();
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.some((s) => s.startsWith("UPDATE tasks"))).toBe(true);
    expect(sql.some((s) => s.startsWith("UPDATE messages"))).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and leaves the message ALONE when the outcome was already settled", async () => {
    // This is the defect the function exists for: guarding the task row alone let a
    // reaped worker rewrite the message the user is looking at.
    client.query.mockImplementation(async (sql: string) =>
      String(sql).trim().startsWith("UPDATE tasks") ? { rowCount: 0 } : { rowCount: 1 },
    );

    await expect(commitTurnOutcome(input)).resolves.toBe(false);

    const sql = statements();
    expect(sql).toContain("ROLLBACK");
    expect(sql.some((s) => s.startsWith("UPDATE messages"))).toBe(false);
    expect(sql).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("claims the row only while it is still ours and still unsettled", async () => {
    await commitTurnOutcome(input);

    const taskUpdate = client.query.mock.calls.map((c) => String(c[0])).find((s) => s.trim().startsWith("UPDATE tasks"))!;
    expect(taskUpdate).toContain("worker_id = $4");
    expect(taskUpdate).toContain("status NOT IN ('completed', 'failed', 'cancelled')");
    // The worker is a bound parameter, never interpolated.
    expect(client.query.mock.calls.find((c) => String(c[0]).trim().startsWith("UPDATE tasks"))![1])
      .toEqual(["task-1", "completed", null, "worker-1"]);
  });

  it("rolls back, releases the client and rethrows when a statement fails", async () => {
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql).trim();
      if (s.startsWith("UPDATE messages")) throw new Error("deadlock detected");
      return { rowCount: 1 };
    });

    await expect(commitTurnOutcome(input)).rejects.toThrow("deadlock detected");
    expect(statements()).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
