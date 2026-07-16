import { describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@/lib/db", () => ({ pool }));

import { cleanupRetention, readRetentionConfig, runRetentionCleanup } from "../retention";

describe("database retention", () => {
  it("uses conservative per-table defaults and accepts zero as keep forever", () => {
    expect(readRetentionConfig({})).toEqual({
      taskDays: 30,
      usageDays: 365,
      auditDays: 365,
      batchSize: 1_000,
    });
    expect(readRetentionConfig({
      TASK_RETENTION_DAYS: "0",
      USAGE_RETENTION_DAYS: "730",
      AUDIT_RETENTION_DAYS: "90",
      DB_RETENTION_BATCH_SIZE: "250",
    })).toEqual({ taskDays: 0, usageDays: 730, auditDays: 90, batchSize: 250 });
  });

  it("falls back instead of accepting malformed or negative limits", () => {
    expect(readRetentionConfig({
      TASK_RETENTION_DAYS: "-1",
      USAGE_RETENTION_DAYS: "1.5",
      AUDIT_RETENTION_DAYS: "nope",
      DB_RETENTION_BATCH_SIZE: "0",
    })).toEqual({ taskDays: 30, usageDays: 365, auditDays: 365, batchSize: 1_000 });
  });

  it("deletes bounded batches while protecting live tasks and pending holds", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // tasks batch 1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // tasks batch 2
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // usage
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit
    const result = await cleanupRetention(
      { query },
      { taskDays: 30, usageDays: 365, auditDays: 365, batchSize: 2 },
    );

    expect(result).toEqual({ tasks: 3, usage: 1, audit: 0 });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][0]).toContain("status IN ('completed', 'failed', 'cancelled')");
    expect(query.mock.calls[0][0]).toContain("'awaiting_answer', 'awaiting_approval'");
    expect(query.mock.calls[0][0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.mock.calls[2][0]).toContain("pending = false");
    expect(query.mock.calls[0][1]).toEqual([30, 2]);
    expect(query.mock.calls[2][1]).toEqual([365, 2]);
  });

  it("does not query a table whose retention is disabled", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await cleanupRetention(
      { query },
      { taskDays: 0, usageDays: 365, auditDays: 365, batchSize: 100 },
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([sql]) => !String(sql).includes("DELETE FROM tasks"))).toBe(true);
  });

  it("uses a transaction-scoped lock and cleanly skips on another replica", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ locked: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: null }); // COMMIT
    const release = vi.fn();
    pool.connect.mockResolvedValueOnce({ query, release });

    await expect(runRetentionCleanup()).resolves.toEqual({
      tasks: 0, usage: 0, audit: 0, skipped: true,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT pg_try_advisory_xact_lock($1) AS locked",
      "COMMIT",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the pooled connection when cleanup fails", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ locked: true }], rowCount: 1 })
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ rows: [], rowCount: null }); // ROLLBACK
    const release = vi.fn();
    pool.connect.mockResolvedValueOnce({ query, release });

    await expect(runRetentionCleanup({ taskDays: 1, usageDays: 0, auditDays: 0, batchSize: 10 }))
      .rejects.toThrow("database unavailable");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
