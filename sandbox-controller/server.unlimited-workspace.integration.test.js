import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { rm, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MAX_WORKSPACE_MB=0 means "no limit" (compose and .env.example promise it, and the
// exec gate already honoured it); the upload path used to read it as a zero-byte cap
// and refuse every file. Own file: the limit is read once at import.
const dbUrl = process.env.TEST_DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const SECRET = "test-secret";
const DATA_ROOT = join(realpathSync(tmpdir()), `ctrl-unlimited-${Math.random().toString(36).slice(2)}`);

d("controller with MAX_WORKSPACE_MB=0", () => {
  let server, store, base;

  beforeAll(async () => {
    process.env.CONTROLLER_NO_BOOT = "1";
    process.env.CONTROLLER_SECRET = SECRET;
    process.env.DATABASE_URL = dbUrl;
    process.env.DATA_ROOT = DATA_ROOT;
    process.env.MAX_WORKSPACE_MB = "0";
    await mkdir(DATA_ROOT, { recursive: true });
    const mod = await import("./server.js");
    ({ server, store } = mod);
    const { LocalFsStore } = await import("./stores/local-fs-store.js");
    await store.init();
    mod.__setTestState({ workspace: new LocalFsStore({ dataRoot: DATA_ROOT, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }), ready: true });
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
});
