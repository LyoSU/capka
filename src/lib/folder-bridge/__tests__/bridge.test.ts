import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolveConflictName, leaseRenewMs, uploadBatch } from "../bridge";
import { conflictName } from "../plan";
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

  beforeEach(() => {
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: FormData }) => {
      posts.push(init.body.getAll("files").map((f) => (f as File).name));
      return new Response(null, { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const read = async (rel: string) => new Blob([rel]);

  it("sends every chunk when nothing objects — the shape a lost lease has to interrupt", async () => {
    await uploadBatch(target, "docs", paths, read);
    expect(posts.map((p) => p.length)).toEqual([100, 100, 50]);
  });

  it("stops before the next chunk once the guard throws", async () => {
    let calls = 0;
    const guard = () => { if (++calls > 2) throw new Error("lease gone"); };
    await expect(uploadBatch(target, "docs", paths, read, undefined, guard)).rejects.toThrow("lease gone");
    // Two chunks went; the third was never assembled, let alone sent.
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

  it("hands the guard to the upload, per file and per chunk", () => {
    const call = runSync.slice(runSync.indexOf("await uploadBatch("), runSync.indexOf("const downloads"));
    expect(call).toContain("guard(); return readLocalFile");
    expect(call).toContain("onProgress, guard,");
  });

  it("sends the lease token with the ancestor write", () => {
    expect(runSync).toContain("/state?token=${encodeURIComponent(token)}");
  });
});
