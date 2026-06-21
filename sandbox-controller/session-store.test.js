import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { PostgresSessionStore } from "./session-store.js";

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

  it("delete() removes the record", async () => {
    await store.delete("s1");
    await store.delete("s2");
    expect(await store.get("s1")).toBeNull();
  });
});
