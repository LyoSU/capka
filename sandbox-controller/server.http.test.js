import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { rm, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boots the REAL controller HTTP server (no Docker) against a throwaway Postgres
// and a fake compute backend, then drives the full session lifecycle over real
// sockets — the coverage the unit tests of reconcile/gc/session-policy can't give.
// Gated on TEST_DATABASE_URL (like session-store.test.js).
const dbUrl = process.env.TEST_DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const SECRET = "test-secret";
const DATA_ROOT = join(realpathSync(tmpdir()), `ctrl-http-${Math.random().toString(36).slice(2)}`);
const UID = process.getuid?.() ?? 1000;
const GID = process.getgid?.() ?? 1000;

d("controller HTTP API (lifecycle)", () => {
  let server, store, LocalFsStore, base;
  const containers = new Map();
  let nextId = 1;
  const backend = {
    async ensureRuntime() {},
    async create(spec) { const handle = `h${nextId++}`; containers.set(handle, { sessionId: spec.sessionId, running: true }); return { handle }; },
    async exec(_handle, cmd) { return { stdout: `ran:${cmd}`, stderr: "", exitCode: 0 }; },
    async destroy(handle) { containers.delete(handle); },
    async list() { return [...containers].map(([handle, c]) => ({ sessionId: c.sessionId, handle, running: c.running })); },
  };

  const auth = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
  const token = (uid, sid) => createHmac("sha256", SECRET).update(`${uid}|${sid}`).digest("hex");
  const post = (sid, uid) => fetch(`${base}/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: sid, userId: uid }) });

  beforeAll(async () => {
    process.env.CONTROLLER_NO_BOOT = "1";
    process.env.CONTROLLER_SECRET = SECRET;
    process.env.DATABASE_URL = dbUrl;
    process.env.DATA_ROOT = DATA_ROOT;
    process.env.MAX_SESSIONS_PER_USER = "2";
    await mkdir(DATA_ROOT, { recursive: true });

    const mod = await import("./server.js");
    ({ server, store } = mod);
    ({ LocalFsStore } = await import("./stores/local-fs-store.js"));
    await store.init();
    await store.pool.query("DELETE FROM sandbox_sessions");
    mod.__setTestState({ backend, workspace: new LocalFsStore({ dataRoot: DATA_ROOT, uid: UID, gid: GID }), ready: true });
    await new Promise((res) => server.listen(0, res));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((res) => (server ? server.close(res) : res()));
    await store?.pool?.end?.();
    await rm(DATA_ROOT, { recursive: true, force: true });
  });

  it("rejects unauthenticated requests", async () => {
    const r = await fetch(`${base}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });

  it("reports healthy", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("creates a session, then reuses the live container", async () => {
    const c = await post("s1", "u1");
    expect(c.status).toBe(201);
    expect((await c.json()).status).toBe("created");
    const r = await post("s1", "u1");
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("reused");
  });

  it("executes a command in the live session", async () => {
    const r = await fetch(`${base}/sessions/s1/exec`, { method: "POST", headers: auth, body: JSON.stringify({ command: "echo hi" }) });
    expect(r.status).toBe(200);
    expect((await r.json()).stdout).toBe("ran:echo hi");
  });

  it("409s exec on a stopped workspace, then revives it (resumed)", async () => {
    await store.setStopped("s1");
    const e = await fetch(`${base}/sessions/s1/exec`, { method: "POST", headers: auth, body: JSON.stringify({ command: "x" }) });
    expect(e.status).toBe(409);
    const r = await post("s1", "u1");
    expect(r.status).toBe(201);
    expect((await r.json()).status).toBe("resumed");
    expect((await store.get("s1")).handle).not.toBeNull();
  });

  it("caps concurrent live containers per user by STOPPING the LRU (no files lost)", async () => {
    await post("s2", "u1"); // s1, s2 live → at cap of 2
    await post("s3", "u1"); // must evict the LRU live one
    const rows = await store.listByUser("u1");
    expect(rows.length).toBe(3);                              // all 3 workspaces kept
    expect(rows.filter((s) => s.handle).length).toBe(2);     // never exceeds the cap
    expect(rows.filter((s) => !s.handle).length).toBe(1);    // evicted one is STOPPED, not deleted
  });

  it("DELETE tears down the container and wipes the workspace row", async () => {
    expect((await post("sdel", "u2")).status).toBe(201);
    const del = await fetch(`${base}/sessions/sdel`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    expect(await store.get("sdel")).toBeNull();
  });

  it("lists files by HMAC token without a live container, honoring depth", async () => {
    const ws = new LocalFsStore({ dataRoot: DATA_ROOT, uid: UID, gid: GID });
    await ws.ensure("u3", "w3");
    await ws.write("u3", "w3", "a.txt", Buffer.from("x"));
    await ws.write("u3", "w3", "sub/b.txt", Buffer.from("y"));
    const q = new URLSearchParams({ path: ".", depth: "3", userId: "u3", token: token("u3", "w3") });
    const r = await fetch(`${base}/sessions/w3/files?${q}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(r.status).toBe(200);
    const paths = (await r.json()).entries.map((e) => e.path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("sub/b.txt"); // nested via depth, no container involved
  });
});
