import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { rm, mkdir, access } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MAX_WORKSPACE_MB=0 means "no limit" (docker-compose.yml promises it, and the
// exec gate already honoured it); the upload path used to read it as a zero-byte cap
// and refuse every file; the workspace copy and the over-quota scan did the same.
// Own file: the limit is read once at import.
const dbUrl = process.env.TEST_DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const SECRET = "test-secret";
const DATA_ROOT = join(realpathSync(tmpdir()), `ctrl-unlimited-${Math.random().toString(36).slice(2)}`);

d("controller with MAX_WORKSPACE_MB=0", () => {
  let server, store, base, ws, overQuotaScan;

  beforeAll(async () => {
    process.env.CONTROLLER_NO_BOOT = "1";
    process.env.CONTROLLER_SECRET = SECRET;
    process.env.DATABASE_URL = dbUrl;
    process.env.DATA_ROOT = DATA_ROOT;
    process.env.MAX_WORKSPACE_MB = "0";
    process.env.REGEN_REAP_IDLE_MS = "1"; // a stopped workspace is idle at once
    await mkdir(DATA_ROOT, { recursive: true });
    const mod = await import("./server.js");
    ({ server, store, overQuotaScan } = mod);
    const { LocalFsStore } = await import("./stores/local-fs-store.js");
    await store.init();
    ws = new LocalFsStore({ dataRoot: DATA_ROOT, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });
    mod.__setTestState({ workspace: ws, ready: true });
    await new Promise((res) => server.listen(0, res));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((res) => (server ? server.close(res) : res()));
    await store?.pool?.end?.();
    await rm(DATA_ROOT, { recursive: true, force: true });
  });

  it("accepts an upload instead of refusing every file", async () => {
    const token = createHmac("sha256", SECRET).update("u1|s1").digest("hex");
    const form = new FormData();
    form.append("file", new Blob(["hello"]), "a.txt");
    const r = await fetch(`${base}/sessions/s1/upload?userId=u1&token=${token}`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: form });
    expect(r.status).toBe(200);
  });

  it("copies a non-empty workspace instead of answering WORKSPACE_FULL", async () => {
    const token = (sid) => createHmac("sha256", SECRET).update(`u2|${sid}`).digest("hex");
    await ws.ensure("u2", "src");
    await ws.ensure("u2", "dst");
    await ws.write("u2", "src", "carry.txt", Buffer.from("hello"));
    const q = new URLSearchParams({ userId: "u2", token: token("dst") });
    const body = JSON.stringify({ srcSessionId: "src", srcToken: token("src"), subdir: "From chat" });
    const r = await fetch(`${base}/sessions/dst/copy-from?${q}`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" }, body });
    expect(r.status).toBe(200);
  });

  it("the over-quota scan leaves the dependency folders of a stopped workspace alone", async () => {
    await ws.ensure("u3", "idle");
    await ws.write("u3", "idle", "node_modules/pkg/index.js", Buffer.from("x".repeat(4096)));
    const now = Date.now() - 60_000;
    await store.upsert({ sessionId: "idle", userId: "u3", handle: null, networkMode: "none", mounts: [], lastActivity: now, createdAt: now });
    await overQuotaScan();
    await expect(access(join(DATA_ROOT, "u3", "idle", "sandbox", "node_modules"))).resolves.toBeUndefined();
  });
});
