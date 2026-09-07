import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The two writes that keep two tabs (or two members of a project) from syncing the
 * same folder over each other: renewing the sync lease while a long sync runs, and
 * swapping the merge-ancestor row only when nobody moved it meanwhile.
 *
 * Both have to be decided inside ONE statement. The ancestor route used to read the
 * row and then write it, so two tabs could both read the same `rev`, both pass the
 * guard, and both write — the server told both of them "ok" and the second silently
 * reverted the first. So the assertions here are about where the comparison lives,
 * not only about the status code: the route must report the outcome the DATABASE
 * reached, and 0 affected rows is a conflict however the earlier read looked.
 */

const { requireActive } = vi.hoisted(() => ({ requireActive: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireActive };
});

const h = vi.hoisted(() => {
  let rows: Record<string, unknown>[] = [];
  let result: { rows: Record<string, unknown>[]; rowCount: number } = { rows: [], rowCount: 0 };
  const calls: { sql: string; params: unknown[] }[] = [];
  const thenable = (getter: () => Record<string, unknown>[]): unknown => {
    const p = Promise.resolve().then(getter);
    return Object.assign(p, { where: () => thenable(getter), limit: (n: number) => Promise.resolve(getter().slice(0, n)) });
  };
  return {
    calls,
    setRows: (r: Record<string, unknown>[]) => { rows = r; },
    /** What the conditional UPDATE reports back — the only thing that decides. */
    setResult: (r: { rows?: Record<string, unknown>[]; rowCount: number }) => { result = { rows: r.rows ?? [], rowCount: r.rowCount }; },
    reset: () => { calls.length = 0; },
    db: { select: () => ({ from: () => thenable(() => rows.map((r) => ({ ...r }))) }) },
    pool: {
      query: (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve(result);
      },
    },
  };
});
vi.mock("@/lib/db", () => ({ db: h.db, pool: h.pool }));

import { PATCH } from "@/app/api/folders/[id]/lease/route";
import { PUT } from "@/app/api/folders/[id]/state/route";

const params = Promise.resolve({ id: "f1" });
/** The ancestor write always carries the sync's lease token; `token: null` drops it. */
const put = (body: unknown, token: string | null = "t1") =>
  PUT(new Request(`http://x/api/folders/f1/state${token === null ? "" : `?token=${token}`}`, { method: "PUT", body: JSON.stringify(body) }), { params });

beforeEach(() => {
  h.reset();
  h.setRows([{ id: "f1", userId: "u1", state: null }]);
  h.setResult({ rowCount: 1, rows: [{ id: "f1" }] });
  requireActive.mockReset().mockResolvedValue({ userId: "u1", role: "user", status: "active" });
});

describe("PATCH /api/folders/[id]/lease — renewal", () => {
  it("pushes the expiry out for the holder and hands back the new one", async () => {
    const before = Date.now();
    const r = await PATCH(new Request("http://x/api/folders/f1/lease?token=t1", { method: "PATCH" }), { params });
    expect(r.status).toBe(200);
    const { expiresAt } = (await r.json()) as { expiresAt: string };
    // Renewing has to buy real time, or a long sync still loses the folder halfway.
    expect(Date.parse(expiresAt)).toBeGreaterThan(before + 60_000);
    const [update] = h.calls; // the ownership read goes through drizzle, not pool
    expect(update.sql).toMatch(/sync_lease->>'token' = \$2/);
    expect(update.params).toEqual(["f1", "t1", expiresAt]);
  });

  it("refuses when the lease is no longer this caller's — the sync must stop", async () => {
    h.setResult({ rowCount: 0, rows: [] });
    const r = await PATCH(new Request("http://x/api/folders/f1/lease?token=t1", { method: "PATCH" }), { params });
    expect(r.status).toBe(409);
  });

  it("400 without a token, so it can never renew a lease it does not hold", async () => {
    const r = await PATCH(new Request("http://x/api/folders/f1/lease", { method: "PATCH" }), { params });
    expect(r.status).toBe(400);
    expect(h.calls).toHaveLength(0); // nothing was written
  });

  it("404 for a folder that isn't the caller's", async () => {
    h.setRows([{ id: "f1", userId: "someone-else", state: null }]);
    const r = await PATCH(new Request("http://x/api/folders/f1/lease?token=t1", { method: "PATCH" }), { params });
    expect(r.status).toBe(404);
  });
});

describe("PUT /api/folders/[id]/state — compare-and-swap", () => {
  it("carries the expected revision INTO the update, not into a check beside it", async () => {
    const r = await put({ expectedRev: 3, state: { v: 1, rev: 4, files: {}, dirs: [] } });
    expect(r.status).toBe(200);
    const [update] = h.calls;
    expect(update.sql).toMatch(/UPDATE attached_folders/);
    expect(update.sql).toMatch(/COALESCE\(state->>'rev', '0'\) = \$4/);
    expect(update.params[0]).toBe("f1");
    expect(update.params[3]).toBe("3");
    expect(JSON.parse(update.params[1] as string)).toEqual({ v: 1, rev: 4, files: {}, dirs: [] });
  });

  // The ancestor row is the one thing a sync that already lost its lease could still
  // win: it writes at the very end, long after its file operations may have been
  // overtaken. So the lease is a predicate of the same statement, and it has to be a
  // LIVE lease — a matching token on an expired one belongs to a superseded run.
  it("swaps only while this sync still holds a live lease on the folder", async () => {
    await put({ expectedRev: 3, state: { v: 1, rev: 4, files: {}, dirs: [] } });
    const [update] = h.calls;
    expect(update.sql).toMatch(/sync_lease->>'token' = \$3/);
    expect(update.sql).toMatch(/\(sync_lease->>'expiresAt'\)::timestamptz > now\(\)/);
    expect(update.params[2]).toBe("t1");
  });

  it("409s when the token is no longer the folder's — the write is refused, not queued", async () => {
    h.setResult({ rowCount: 0, rows: [] });
    const r = await put({ expectedRev: 3, state: { v: 1, rev: 4, files: {}, dirs: [] } }, "stale-token");
    expect(r.status).toBe(409);
  });

  it("400 without a token, and writes nothing", async () => {
    const r = await put({ expectedRev: 3, state: { v: 1, rev: 4, files: {}, dirs: [] } }, null);
    expect(r.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  // The one that fails on a read-then-write: the row we read still says rev 3, so the
  // old guard passed and answered "ok" — while the write itself matched nothing,
  // because another tab had already moved the row on.
  it("409s when the update matched no row, even though the read looked fine", async () => {
    h.setRows([{ id: "f1", userId: "u1", state: { v: 1, rev: 3 } }]);
    h.setResult({ rowCount: 0, rows: [] });
    const r = await put({ expectedRev: 3, state: { v: 1, rev: 4, files: {}, dirs: [] } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/changed elsewhere/);
  });

  it("treats an absent state as revision 0, the same starting point the bridge assumes", async () => {
    await put({ expectedRev: 0, state: { v: 1, rev: 1, files: {}, dirs: [] } });
    expect(h.calls[0].params[3]).toBe("0");
  });

  it("drops the revision predicate when none was claimed, but keeps the lease one", async () => {
    const r = await put({ state: { v: 1, rev: 1, files: {}, dirs: [] } });
    expect(r.status).toBe(200);
    expect(h.calls[0].sql).not.toMatch(/state->>'rev'/);
    expect(h.calls[0].sql).toMatch(/sync_lease->>'token'/);
  });

  // `null` was accepted as "clear the ancestor" and no caller ever sent it, but it
  // reset the revision chain: null reads as revision 0, so null -> rev 1 -> null let
  // a writer still holding expectedRev 0 win the swap and restore its old manifest
  // over a newer one. Nothing may lower the revision now.
  it("refuses a null state outright, so the revision can never go back to 0", async () => {
    for (const rev of [undefined, 0, 1]) {
      h.reset();
      const r = await put(rev === undefined ? { state: null } : { expectedRev: rev, state: null });
      expect(r.status).toBe(400);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("400 on a state that isn't the versioned shape — and writes nothing", async () => {
    const r = await put({ expectedRev: 1, state: { files: {} } });
    expect(r.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("404 for a folder that isn't the caller's — and writes nothing", async () => {
    h.setRows([{ id: "f1", userId: "someone-else", state: null }]);
    const r = await put({ expectedRev: 0, state: { v: 1, rev: 1, files: {}, dirs: [] } });
    expect(r.status).toBe(404);
    expect(h.calls).toHaveLength(0);
  });
});
