import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The bulk-upload route is the other write a sync makes through the API, and it used
 * to accept whatever arrived. A batch is assembled over seconds of file reads, so the
 * client's own check can always be overtaken between its last look and this request —
 * and a stale tab whose lease lapsed long ago was writing into the folder unopposed.
 *
 * So a batch that names a lease has to still hold it, on the same condition the
 * ancestor swap uses. Naming no lease is unchanged: the one-shot fallback import has
 * no folder row to check against.
 */

const { requireActive } = vi.hoisted(() => ({ requireActive: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireActive };
});
vi.mock("@/lib/manage/controls/folders", () => ({
  pcFolderLevel: () => Promise.resolve("everyone"),
  canAttachPc: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({ take: () => ({ ok: true }) }));
vi.mock("@/lib/sandbox/target", () => ({
  resolveWorkspaceTarget: () => Promise.resolve({ sessionKey: "sk-1" }),
}));

const h = vi.hoisted(() => {
  /** The folder row the fence asks about: absent, or holding a lease that may have
   *  expired. The route's predicate is evaluated here the way Postgres evaluates it,
   *  so the test states a WORLD and the route's own question decides the answer. */
  let row: { token: string; live: boolean } | null = null;
  const calls: { sql: string; params: unknown[] }[] = [];
  const uploaded: string[] = [];
  let failOn: string | null = null;
  return {
    calls, uploaded,
    setRow: (r: { token: string; live: boolean } | null) => { row = r; },
    /** Make the controller refuse this relative path, as a broken sandbox would. */
    setFailOn: (rel: string | null) => { failOn = rel; },
    reset: () => { calls.length = 0; uploaded.length = 0; row = null; failOn = null; },
    pool: {
      query: (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        // `LIVE AND token IS DISTINCT FROM $3` — a NULL token in the request is
        // distinct from any real one, which is what refuses an unaccompanied write.
        const blocked = !!row && row.live && row.token !== params[2];
        return Promise.resolve({ rows: blocked ? [{ one: 1 }] : [], rowCount: blocked ? 1 : 0 });
      },
    },
    uploadFile: (_key: string, dir: string, file: File): Promise<void> => {
      const rel = `${dir}/${file.name}`;
      if (failOn && rel === failOn) return Promise.reject(new Error("controller refused"));
      uploaded.push(rel);
      return Promise.resolve();
    },
  };
});
vi.mock("@/lib/db", () => ({ pool: h.pool }));
vi.mock("@/lib/sandbox/client", () => ({ uploadFile: h.uploadFile }));

import { POST } from "@/app/api/folders/upload/route";

/** An upload request for "docs", optionally naming a lease token and carrying more
 *  than one file (the write pool only has something to race with several). */
function req(lease?: string, names: string[] = ["a.txt"]): Request {
  const form = new FormData();
  form.append("chatId", "c1");
  form.append("name", "docs");
  if (lease) form.append("lease", lease);
  for (const n of names) form.append("files", new File(["hello"], n));
  return new Request("http://x/api/folders/upload", { method: "POST", body: form });
}

beforeEach(() => {
  h.reset();
  requireActive.mockReset().mockResolvedValue({ userId: "u1", role: "user", status: "active" });
});

describe("POST /api/folders/upload — the sync lease fence", () => {
  it("asks the folder row, always, and binds the request's token to the question", async () => {
    h.setRow({ token: "t1", live: true });
    const r = await POST(req("t1"));
    expect(r.status).toBe(200);
    const [check] = h.calls;
    expect(check.sql).toMatch(/FROM attached_folders WHERE session_key = \$1 AND name = \$2/);
    expect(check.sql).toMatch(/\(sync_lease->>'expiresAt'\)::timestamptz > now\(\)/);
    expect(check.sql).toMatch(/sync_lease->>'token' IS DISTINCT FROM \$3/);
    expect(check.params).toEqual(["sk-1", "docs", "t1"]);
    expect(h.uploaded).toEqual(["docs/a.txt"]);
  });

  // The bypass: the fence used to be `if (lease)`, so a request that simply left the
  // field out skipped it and wrote into a folder another window was mid-sync on.
  it("409s a batch that names NO lease while the folder is held", async () => {
    h.setRow({ token: "t1", live: true });
    const r = await POST(req());
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("LEASE_GONE");
    expect(h.uploaded).toEqual([]);
    expect(h.calls[0].params[2]).toBeNull(); // the absent token reaches SQL as NULL
  });

  it("409s a batch whose token is not the holder's", async () => {
    h.setRow({ token: "t1", live: true });
    const r = await POST(req("stale"));
    expect(r.status).toBe(409);
    expect(h.uploaded).toEqual([]);
  });

  // Nobody's folder: anyone may write. These are the paths that legitimately hold no
  // lease — the one-shot fallback import has no row at all, and a released or lapsed
  // lease leaves a row that claims nothing.
  it("accepts a batch when there is no folder row", async () => {
    const r = await POST(req());
    expect(r.status).toBe(200);
    expect(h.uploaded).toEqual(["docs/a.txt"]);
  });

  it("accepts a batch naming no lease when the row's lease has expired", async () => {
    h.setRow({ token: "t1", live: false });
    const r = await POST(req());
    expect(r.status).toBe(200);
    expect(h.uploaded).toEqual(["docs/a.txt"]);
  });
});

/**
 * The route forwards a batch through six workers. `Promise.all` rejected the moment
 * the first one did, so this handler answered while up to five writes were still in
 * flight — and the client's sync, seeing the failure, released the folder lease in
 * its `finally`, letting a second tab acquire it while those writes landed under the
 * new holder. The response must be the true end of this request's writes.
 */
describe("POST /api/folders/upload — a failed batch leaves nothing in flight", () => {
  const many = Array.from({ length: 30 }, (_, i) => `f${i}.txt`);

  it("answers 500 and names how much of the batch it could not write", async () => {
    h.setFailOn("docs/f0.txt");
    const r = await POST(req(undefined, many));
    expect(r.status).toBe(500);
  });

  it("stops handing files to a controller that has already refused one", async () => {
    h.setFailOn("docs/f0.txt");
    await POST(req(undefined, many));
    // Six workers each take one file, then all of them see the failure and stop, so
    // the tail of the batch is never attempted. Without the shared flag the other
    // five workers would have walked the remaining twenty-four.
    expect(h.uploaded.length).toBeLessThan(many.length - 1);
    expect(h.uploaded).not.toContain(`docs/${many[many.length - 1]}`);
  });

  it("writes the whole batch when the controller is healthy", async () => {
    const r = await POST(req(undefined, many));
    expect(r.status).toBe(200);
    expect((await r.json()).count).toBe(many.length);
    expect(h.uploaded).toHaveLength(many.length);
  });
});
