import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolveConflictName, leaseRenewMs, uploadBatch, serverTree, loadAncestor, LEASE_GONE } from "../bridge";
import { conflictName, planSync, planDirs } from "../plan";
import { chatTarget } from "@/lib/workspace-target";

/**
 * The two decisions the bridge makes that are not handle I/O, so they can be tested
 * without a browser: which name a conflict copy is written under, and how often the
 * sync lease has to be renewed.
 */

const at = new Date(2026, 8, 7, 14, 32, 4);
/** A predicate over a fixed set of paths, standing in for "the manifests plus the
 *  real directory" the sync asks. */
const taken = (...names: string[]) => async (n: string) => names.includes(n);

describe("resolveConflictName", () => {
  it("uses the plain dated name when nothing is there", async () => {
    expect(await resolveConflictName("report.docx", at, taken())).toBe("report.conflict-2026-09-07-143204.docx");
  });

  // The defect: the copy was written with a plain createWritable(), which truncates.
  // A second conflict on report.docx in the same second landed on the first copy and
  // destroyed the version that had just been "kept".
  it("steps past a name that already exists rather than overwriting it", async () => {
    const first = conflictName("report.docx", at);
    expect(await resolveConflictName("report.docx", at, taken(first))).toBe("report.conflict-2026-09-07-143204-2.docx");
  });

  it("keeps stepping while the counter names are taken too", async () => {
    const busy = taken(
      conflictName("report.docx", at, 1),
      conflictName("report.docx", at, 2),
      conflictName("report.docx", at, 3),
    );
    expect(await resolveConflictName("report.docx", at, busy)).toBe("report.conflict-2026-09-07-143204-4.docx");
  });

  // Aborting loses nothing: the merge base is only written at the end of a sync, so
  // the next run starts from the same ancestor and retries. Handing back a colliding
  // name would destroy a file instead.
  it("refuses to return a colliding name when every candidate is taken", async () => {
    await expect(resolveConflictName("report.docx", at, async () => true)).rejects.toThrow(/free name/);
  });

  it("asks about the exact path it would write, directory included", async () => {
    const asked: string[] = [];
    await resolveConflictName("a/b/report.docx", at, async (n) => { asked.push(n); return false; });
    expect(asked).toEqual(["a/b/report.conflict-2026-09-07-143204.docx"]);
  });
});

describe("leaseRenewMs", () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0);
  const inMs = (ms: number) => new Date(now + ms).toISOString();

  it("renews several times over the lease's life, so missed ticks are survivable", () => {
    // A hidden tab's timers are throttled to roughly one a minute, so the interval
    // has to leave room for a few of them to be skipped.
    const ttl = 10 * 60 * 1000;
    const every = leaseRenewMs(inMs(ttl), now);
    expect(ttl / every).toBeGreaterThanOrEqual(5);
  });

  it("never hammers the endpoint on a short lease", () => {
    expect(leaseRenewMs(inMs(10_000), now)).toBe(15_000);
    expect(leaseRenewMs(inMs(-60_000), now)).toBe(15_000);
  });

  it("caps the interval so a very long lease is still renewed regularly", () => {
    expect(leaseRenewMs(inMs(24 * 60 * 60 * 1000), now)).toBe(120_000);
  });

  it("falls back to a minute when the server sent no usable expiry", () => {
    expect(leaseRenewMs(undefined, now)).toBe(60_000);
    expect(leaseRenewMs("not a date", now)).toBe(60_000);
  });
});

// The controller flags a listing `truncated` when it could not see the whole tree —
// the entry cap, the depth cap, or a directory it failed to read (EACCES, EIO…). The
// planner reads a synced path the server no longer lists as a server-side delete, so
// a partial listing must never reach it.
describe("serverTree — an incomplete listing never becomes a plan", () => {
  const listing = (truncated: boolean) => vi.fn(async () => Response.json({
    entries: [{ path: "docs/a.txt", isDirectory: false, size: 1, modifiedAt: "2026-09-07T12:00:00.000Z", hash: "ha" }],
    truncated,
  }));
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a truncated listing that the planner would turn into local deletes", async () => {
    const entry = { mtime: 0, size: 1, hash: "ha" };
    // What the refusal prevents: b.txt sits in an unreadable directory, so the listing omits it.
    expect(planSync({ "a.txt": entry, "b.txt": entry }, { "a.txt": entry }, { "a.txt": entry, "b.txt": entry }).deleteLocal).toEqual(["b.txt"]);
    vi.stubGlobal("fetch", listing(true));
    await expect(serverTree(chatTarget("c1"), "docs")).rejects.toThrow(/could not be listed in full/);
  });

  it("reads a complete listing into the manifest", async () => {
    vi.stubGlobal("fetch", listing(false));
    const tree = await serverTree(chatTarget("c1"), "docs");
    expect(Object.keys(tree.files)).toEqual(["a.txt"]);
    expect(tree.missing).toBe(false);
  });
});

// A workspace copy that is not there at all (the idle-workspace reaper removed the
// workspace, or the folder was never uploaded) lists as empty. Against the stored
// ancestor, empty reads as "every file was deleted on the server".
describe("a missing workspace copy never reads as every file deleted", () => {
  afterEach(() => vi.unstubAllGlobals());
  const entry = { mtime: 0, size: 1, hash: "ha" };
  const local = { "a.txt": entry, "sub/b.txt": entry };

  it("is reported by serverTree, apart from an empty folder", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: [], truncated: false, missing: true })));
    expect((await serverTree(chatTarget("c1"), "docs")).missing).toBe(true);
    // An older controller sends no flag: that stays an ordinary listing.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: [], truncated: false })));
    expect((await serverTree(chatTarget("c1"), "docs")).missing).toBe(false);
  });

  it("is planned against no ancestor, which deletes nothing and puts the copy back", () => {
    // The hazard: the stored ancestor plus an empty server is a delete of everything.
    expect(planSync(local, {}, local).deleteLocal.sort()).toEqual(["a.txt", "sub/b.txt"]);
    const union = planSync(local, {}, {});
    expect(union.deleteLocal).toEqual([]);
    expect(union.upload.sort()).toEqual(["a.txt", "sub/b.txt"]);
    expect(planDirs(["sub"], [], [], union.upload).deleteLocal).toEqual([]);
  });

  it("is what runSync plans files and folders against, fetched before anything is uploaded", () => {
    const src = readFileSync("src/lib/folder-bridge/bridge.ts", "utf8");
    const runSync = src.slice(src.indexOf("async function runSync("));
    const at = runSync.indexOf("await loadAncestor(folder.id, token, missing)");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(runSync.indexOf("await uploadBatch("));
    expect(runSync).toContain("planSync(local, remote, ancestor.files,");
    expect(runSync).toContain("planDirs(localDirs, remoteDirs, ancestor.dirs,");
  });
});

/**
 * The union above re-uploads the whole folder, in chunks. Planning against an empty
 * ancestor only in memory left the old full one stored until the very last write, so a
 * run cut short part-way handed the next sync a full ancestor over a partial workspace —
 * and that sync, no longer seeing a missing copy, deleted every local file the
 * re-upload had not reached. The reset is stored before the first upload instead.
 */
describe("loadAncestor — a missing copy's reset is stored before the re-upload", () => {
  afterEach(() => vi.unstubAllGlobals());
  const entry = { mtime: 0, size: 1, hash: "ha" };
  // 150 files over three folders: two upload chunks, the second one never lands.
  const local = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`d${i % 3}/f${i}.txt`, entry]));
  const localDirs = ["d0", "d1", "d2"];

  /** The state route and the upload route, enough of each to hold the ancestor row
   *  (revision CAS + lease token, like the real UPDATE) and fail the second chunk. */
  function server(row: { v: 1; rev: number; files: Record<string, typeof entry>; dirs: string[] } | null, opts: { stateReadable?: boolean } = {}) {
    const calls: string[] = [];
    const uploaded: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://capka.test");
      const method = init?.method ?? "GET";
      calls.push(`${method} ${u.pathname}`);
      if (u.pathname === "/api/folders/f1/state" && method === "GET") {
        return opts.stateReadable === false ? new Response(null, { status: 500 }) : Response.json({ state: row });
      }
      if (u.pathname === "/api/folders/f1/state" && method === "PUT") {
        const { expectedRev, state } = JSON.parse(init!.body as string);
        if (u.searchParams.get("token") !== "tok" || (row?.rev ?? 0) !== expectedRev) return Response.json({}, { status: 409 });
        row = state;
        return Response.json({ ok: true });
      }
      if (u.pathname === "/api/folders/upload") {
        if (calls.filter((c) => c.endsWith("/upload")).length > 1) return new Response(null, { status: 500 });
        uploaded.push(...(init!.body as FormData).getAll("files").map((f) => (f as File).name));
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    return { calls, uploaded, row: () => row };
  }

  it("leaves the next sync a union, not a delete, when the re-upload is cut short", async () => {
    const full = { v: 1 as const, rev: 4, files: local, dirs: localDirs };
    const srv = server(full);

    // Run 1: the workspace copy is gone. The ancestor it plans against is empty AND stored.
    const first = await loadAncestor("f1", "tok", true);
    expect(first).toEqual({ files: {}, dirs: [], rev: 5 });
    const plan = planSync(local, {}, first.files);
    await expect(uploadBatch(chatTarget("c1"), "docs", plan.upload, async () => new Blob(["x"]), { lease: "tok" }))
      .rejects.toThrow("upload failed");
    // The reset went out before the first chunk did.
    expect(srv.calls.indexOf("PUT /api/folders/f1/state")).toBeLessThan(srv.calls.indexOf("POST /api/folders/upload"));
    expect(srv.uploaded).toHaveLength(100);

    // Run 2: the copy exists again, holding only what the first chunk carried.
    const remote = Object.fromEntries(srv.uploaded.map((p) => [p, entry]));
    const remoteDirs = [...new Set(srv.uploaded.map((p) => p.split("/")[0]))];
    expect(remoteDirs).not.toContain("d2"); // a whole folder the re-upload never reached
    const second = await loadAncestor("f1", "tok", false);
    const next = planSync(local, remote, second.files);
    expect(next.deleteLocal).toEqual([]);
    expect(next.upload).toHaveLength(50);
    expect(planDirs(localDirs, remoteDirs, second.dirs, next.upload).deleteLocal).toEqual([]);

    // What the stored full ancestor would have planned instead.
    expect(planSync(local, remote, full.files).deleteLocal).toHaveLength(50);
    expect(planDirs(localDirs, remoteDirs, full.dirs, []).deleteLocal).toEqual(["d2"]);
  });

  it("fails the sync before any upload when the reset does not land", async () => {
    // A lease that is no longer this run's: the route refuses the swap.
    const srv = server({ v: 1, rev: 4, files: local, dirs: localDirs });
    await expect(loadAncestor("f1", "lost-lease", true)).rejects.toThrow(/sync state \(HTTP 409\)/);
    expect(srv.row()!.files).toBe(local);
    expect(srv.calls.some((c) => c.endsWith("/upload"))).toBe(false);
  });

  it("resets an unreadable row too, and fails rather than guess when one is there", async () => {
    const srv = server({ v: 1, rev: 4, files: local, dirs: localDirs }, { stateReadable: false });
    await expect(loadAncestor("f1", "tok", true)).rejects.toThrow(/HTTP 409/);
    expect(srv.row()!.files).toBe(local);
    // No state at all: the rev-0 reset lands and the sync goes on as a union.
    server(null, { stateReadable: false });
    expect(await loadAncestor("f1", "tok", true)).toEqual({ files: {}, dirs: [], rev: 1 });
  });

  it("costs no extra request when there is nothing to forget, or nothing is missing", async () => {
    let srv = server(null);
    expect(await loadAncestor("f1", "tok", true)).toEqual({ files: {}, dirs: [], rev: 0 });
    expect(srv.calls).toEqual(["GET /api/folders/f1/state"]);
    srv = server({ v: 1, rev: 4, files: local, dirs: localDirs });
    expect((await loadAncestor("f1", "tok", false)).files).toEqual(local);
    expect(srv.calls).toEqual(["GET /api/folders/f1/state"]);
  });
});

/**
 * A sync holds one folder lease across its whole span, and the span moves up to
 * FOLDER_MAX_FILES files. Checking the lease once per PHASE meant a lease lost at
 * file 40 of 5,000 still pushed every remaining chunk and wrote every remaining
 * download — against a folder a second tab was by then reconciling to its own plan.
 * So the check runs before each individual mutation, and it throws.
 */
describe("uploadBatch — the lease is checked per chunk, not once per upload", () => {
  const target = chatTarget("c1");
  const paths = Array.from({ length: 250 }, (_, i) => `f${i}.txt`);
  let posts: string[][];
  let fields: FormData[];

  beforeEach(() => {
    posts = [];
    fields = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: FormData }) => {
      posts.push(init.body.getAll("files").map((f) => (f as File).name));
      fields.push(init.body);
      return new Response(null, { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const read = async (rel: string) => new Blob([rel]);

  /** A guard that passes until its `throwOn`-th call, so a test can say exactly
   *  which of the two checks in a chunk it wants to fail. */
  const guardThrowingOn = (throwOn: number) => {
    const state = { calls: 0 };
    return [() => { if (++state.calls >= throwOn) throw new Error("lease gone"); }, state] as const;
  };

  it("sends every chunk when nothing objects — the shape a lost lease has to interrupt", async () => {
    await uploadBatch(target, "docs", paths, read);
    expect(posts.map((p) => p.length)).toEqual([100, 100, 50]);
  });

  it("checks the lease twice per chunk, before the reads and after them", async () => {
    const guard = vi.fn();
    await uploadBatch(target, "docs", paths, read, { guard });
    expect(guard).toHaveBeenCalledTimes(6); // three chunks
  });

  // The blocker: the check at the top of the loop runs BEFORE `read` is called for
  // 100 files, which takes seconds. A lease lost during those reads left the check
  // already passed, so the assembled batch went out anyway. The second check closes
  // that window — nothing may be sent after it fails.
  it("does not send a chunk whose files were read after the lease went", async () => {
    const [guard, state] = guardThrowingOn(2);
    await expect(uploadBatch(target, "docs", paths, read, { guard })).rejects.toThrow("lease gone");
    expect(state.calls).toBe(2); // passed at the top, failed after the reads
    expect(posts).toEqual([]);
  });

  it("stops before the next chunk once the guard throws at the top", async () => {
    const [guard] = guardThrowingOn(5); // chunks 1 and 2 take calls 1-4
    await expect(uploadBatch(target, "docs", paths, read, { guard })).rejects.toThrow("lease gone");
    expect(posts.map((p) => p.length)).toEqual([100, 100]);
  });

  it("stops mid-chunk when the per-file read objects, before that chunk is sent", async () => {
    const guarded = async (rel: string) => {
      if (rel === "f40.txt") throw new Error("lease gone");
      return new Blob([rel]);
    };
    await expect(uploadBatch(target, "docs", paths, guarded)).rejects.toThrow("lease gone");
    expect(posts).toEqual([]);
  });

  // The client cannot fence the gap between its own last check and the server's
  // write, so the batch names its lease and the server refuses a stale one. That
  // refusal has to end the sync the way a lost lease does, not read as a transient
  // upload failure the caller might treat differently.
  it("names the lease in the request when it has one, and omits it otherwise", async () => {
    await uploadBatch(target, "docs", ["a.txt"], read, { lease: "t1" });
    expect(fields[0].get("lease")).toBe("t1");
    await uploadBatch(target, "docs", ["a.txt"], read);
    expect(fields[1].get("lease")).toBeNull();
  });

  it("turns the server's refusal into the same lease-gone failure the guard raises", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "LEASE_GONE" }, { status: 409 })));
    await expect(uploadBatch(target, "docs", ["a.txt"], read, { lease: "stale" })).rejects.toThrow(LEASE_GONE);
  });
});

/**
 * The rest of the sync's mutations sit inside handle I/O that has no vitest surface,
 * so what is pinned here is the invariant a reviewer would otherwise have to re-read
 * the function to check: no file is written or deleted without the lease being
 * verified immediately beforehand.
 */
describe("runSync guards each mutation individually", () => {
  const src = readFileSync("src/lib/folder-bridge/bridge.ts", "utf8");
  const runSync = src.slice(src.indexOf("async function runSync("));
  const MUTATIONS = ["writeLocalFile(", "deleteFromWorkspace(", "deleteLocalFile(", "deleteLocalDir("];
  const code = (line: string) => line.trim() !== "" && !line.trim().startsWith("//");

  it("has no write or delete that a guard does not immediately precede", () => {
    const lines = runSync.split("\n");
    const unguarded = lines.filter((line, i) => {
      if (!code(line) || !MUTATIONS.some((m) => line.includes(m))) return false;
      const prev = [...lines.slice(0, i)].reverse().find(code) ?? "";
      return !line.includes("guard()") && !prev.includes("guard()");
    });
    expect(unguarded).toEqual([]);
    // The filter above is worthless if it matches nothing at all.
    expect(runSync.match(/guard\(\)/g)!.length).toBeGreaterThanOrEqual(MUTATIONS.length);
  });

  it("hands the guard and the lease to the upload", () => {
    const call = runSync.slice(runSync.indexOf("await uploadBatch("), runSync.indexOf("const downloads"));
    expect(call).toContain("guard(); return readLocalFile");
    expect(call).toContain("{ onProgress, guard, lease: token }");
  });

  it("sends the lease token with the ancestor write", () => {
    expect(runSync).toContain("await putState(folder.id, token, ancestor.rev,");
    expect(src).toContain("/state?token=${encodeURIComponent(token)}");
  });

  // A state PUT that did not land means no new merge ancestor exists, so the run did
  // not finish. It used to only warn and return success, which told the person their
  // folder was merged while the next sync would start from the old base — the state
  // a pre-deploy tab lands in, since its bundle sends no token and gets a 400.
  it("fails the sync when the ancestor write did not land", () => {
    expect(runSync).toContain("if (!put?.ok)");
    expect(runSync).toMatch(/if \(!put\?\.ok\) \{\s*\n\s*throw new Error/);
    expect(runSync).not.toContain("console.warn");
  });
});
