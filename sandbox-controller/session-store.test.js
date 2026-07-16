import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import { PostgresSessionStore } from "./session-store.js";

describe("PostgresSessionStore activity flush", () => {
  it("retains activity for retry when Postgres rejects a flush", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ rows: [] });
    const store = new PostgresSessionStore({ pool: { query } });
    store.touch("retry", 123);

    await expect(store.flush()).rejects.toThrow("database unavailable");
    await store.flush();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(expect.any(String), ["retry", 123]);
  });

  it("does not drop a newer touch that arrives during a flush", async () => {
    let release;
    const firstQuery = new Promise((resolve) => { release = resolve; });
    const query = vi.fn()
      .mockImplementationOnce(() => firstQuery)
      .mockResolvedValueOnce({ rows: [] });
    const store = new PostgresSessionStore({ pool: { query } });
    store.touch("active", 100);

    const flushing = store.flush();
    store.touch("active", 200);
    release({ rows: [] });
    await flushing;
    await store.flush();

    expect(query.mock.calls.map(([, values]) => values)).toEqual([
      ["active", 100],
      ["active", 200],
    ]);
  });
});

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("PostgresSessionStore", () => {
  let pool, store;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    store = new PostgresSessionStore({ pool });
    await store.init();
    await pool.query("DELETE FROM sandbox_sessions");
  });
  afterAll(async () => { await pool?.end(); });

  it("upsert/get round-trips and preserves networkMode", async () => {
    await store.upsert({ sessionId: "s1", userId: "u1", handle: "c1", networkMode: "none", lastActivity: 1, createdAt: 1 });
    const got = await store.get("s1");
    expect(got.networkMode).toBe("none");
    expect(got.handle).toBe("c1");
    expect(got.lastActivity).toBe(1);
  });

  it("touch() + flush() persists lastActivity", async () => {
    store.touch("s1", 999);
    await store.flush();
    expect((await store.get("s1")).lastActivity).toBe(999);
  });

  it("listByUser returns the user's sessions", async () => {
    await store.upsert({ sessionId: "s2", userId: "u1", handle: "c2", networkMode: "bridge", lastActivity: 2, createdAt: 2 });
    const list = await store.listByUser("u1");
    expect(list.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("setStopped() nulls the handle but keeps the row and lastActivity", async () => {
    await store.upsert({ sessionId: "stop", userId: "u1", handle: "c9", networkMode: "none", lastActivity: 42, createdAt: 1 });
    await store.setStopped("stop");
    const got = await store.get("stop");
    expect(got).not.toBeNull();
    expect(got.handle).toBeNull();
    expect(got.lastActivity).toBe(42); // reaper clock keeps counting from real use
    await store.delete("stop");
  });

  it("withSessionLock serializes the critical section for one session", async () => {
    const order = [];
    const slow = (tag) => store.withSessionLock("lk", async () => {
      order.push(`${tag}:enter`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${tag}:exit`);
    });
    await Promise.all([slow("A"), slow("B")]);
    // Whichever wins, the two sections never interleave (no enter between an enter/exit pair).
    const a = order.indexOf("A:enter"), b = order.indexOf("B:enter");
    const first = a < b ? "A" : "B";
    const second = first === "A" ? "B" : "A";
    expect(order).toEqual([`${first}:enter`, `${first}:exit`, `${second}:enter`, `${second}:exit`]);
  });

  it("delete() removes the record", async () => {
    await store.delete("s1");
    await store.delete("s2");
    expect(await store.get("s1")).toBeNull();
  });
});
