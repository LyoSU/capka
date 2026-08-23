import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Guards the boot-order failure seen locally on 2026-08-23: the platform
 * started ~3 minutes BEFORE its Postgres, so the single migration attempt hit
 * ECONNREFUSED. Boot swallowed it and carried on; the database then came up,
 * every other query worked, and the schema stayed frozen three migrations
 * behind until someone restarted the process. The user-visible symptom named
 * the missing table ("relation \"message_effects\" does not exist"), never the
 * migration that never ran.
 */

const migrate = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate }));
vi.mock("../index", () => ({ db: {}, pool: { connect } }));

describe("runMigrations", () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    migrate.mockReset().mockResolvedValue(undefined);
    client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    connect.mockReset().mockResolvedValue(client);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("applies once and releases the lock when the database is reachable", async () => {
    const { runMigrations } = await import("../migrate");

    await runMigrations();

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual([
      "SELECT pg_advisory_lock($1)",
      "SELECT pg_advisory_unlock($1)",
    ]);
  });

  it("does not block boot when the database is not up yet", async () => {
    const { runMigrations } = await import("../migrate");
    connect.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));

    await expect(runMigrations()).resolves.toBeUndefined();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("retries in the background until a late database is migrated", async () => {
    const { runMigrations } = await import("../migrate");
    connect.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));

    await runMigrations();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it("keeps backing off across repeated failures instead of giving up", async () => {
    const { runMigrations } = await import("../migrate");
    const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    connect.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused());

    await runMigrations();

    await vi.advanceTimersByTimeAsync(1_000); // retry 1 — still refused
    expect(migrate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000); // retry 2 — still refused
    expect(migrate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000); // retry 3 — database is up
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it("releases the advisory lock when the migration itself fails", async () => {
    const { runMigrations } = await import("../migrate");
    migrate.mockRejectedValueOnce(new Error("syntax error at or near"));

    await runMigrations();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [8732025]);
  });
});
