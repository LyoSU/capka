import { describe, it, expect } from "vitest";
import { hashCandidates, mergeHashed, localFileExists, type DirHandle, type HashedManifest, type LocalManifest } from "../local-fs";

describe("hashCandidates — the prefilter that avoids re-hashing untouched files", () => {
  const prev: HashedManifest = {
    "a.txt": { mtime: 100, size: 3, hash: "A" },
    "b.txt": { mtime: 100, size: 5, hash: "B" },
  };

  it("flags a new file", () => {
    const cur: LocalManifest = { ...stat(prev), "c.txt": { mtime: 100, size: 2 } };
    expect(hashCandidates(cur, prev)).toEqual(["c.txt"]);
  });

  it("flags a file whose mtime or size changed", () => {
    const cur: LocalManifest = { "a.txt": { mtime: 200, size: 3 }, "b.txt": { mtime: 100, size: 9 } };
    expect(hashCandidates(cur, prev)).toEqual(["a.txt", "b.txt"]);
  });

  it("skips unchanged files (same mtime+size)", () => {
    expect(hashCandidates(stat(prev), prev)).toEqual([]);
  });

  it("everything is a candidate when there is no previous manifest", () => {
    expect(hashCandidates(stat(prev), {})).toEqual(["a.txt", "b.txt"]);
  });
});

describe("mergeHashed — reuse cached hashes, apply fresh ones", () => {
  const prev: HashedManifest = { "a.txt": { mtime: 100, size: 3, hash: "A" } };

  it("keeps the cached hash for unchanged files and takes the fresh hash for changed ones", () => {
    const cur: LocalManifest = { "a.txt": { mtime: 100, size: 3 }, "b.txt": { mtime: 100, size: 5 } };
    const merged = mergeHashed(cur, prev, { "b.txt": "B" });
    expect(merged).toEqual({
      "a.txt": { mtime: 100, size: 3, hash: "A" },
      "b.txt": { mtime: 100, size: 5, hash: "B" },
    });
  });

  it("drops entries with no hash available (neither fresh nor cached)", () => {
    const cur: LocalManifest = { "z.txt": { mtime: 1, size: 1 } };
    expect(mergeHashed(cur, {}, {})).toEqual({});
  });
});

/**
 * A conflict copy is written with `createWritable()`, which truncates whatever it
 * lands on, and the manifests cannot vouch for a path on their own: they are a
 * snapshot, and they deliberately leave out ignored and oversized files. So the
 * name is probed against the real directory before anything is written.
 */
describe("localFileExists — the probe a conflict copy asks before it writes", () => {
  /** A directory handle over a flat list of "a/b/c.txt" paths. Only what the probe
   *  touches is implemented; the rest of the interface throws if it is ever used. */
  function fakeRoot(paths: string[]): DirHandle {
    const dir = (prefix: string): DirHandle => ({
      kind: "directory",
      name: prefix,
      entries: () => { throw new Error("not used"); },
      getDirectoryHandle: async (name) => {
        const next = prefix ? `${prefix}/${name}` : name;
        if (!paths.some((p) => p.startsWith(`${next}/`))) throw new Error("NotFoundError");
        return dir(next);
      },
      getFileHandle: async (name) => {
        const full = prefix ? `${prefix}/${name}` : name;
        if (!paths.includes(full)) throw new Error("NotFoundError");
        return { kind: "file", name, getFile: () => { throw new Error("not used"); }, createWritable: () => { throw new Error("not used"); } };
      },
      removeEntry: async () => { throw new Error("not used"); },
    });
    return dir("");
  }

  it("sees a file that is there, at the root and nested", async () => {
    const root = fakeRoot(["report.docx", "a/b/report.docx"]);
    expect(await localFileExists(root, "report.docx")).toBe(true);
    expect(await localFileExists(root, "a/b/report.docx")).toBe(true);
  });

  it("answers false for a free name rather than throwing", async () => {
    const root = fakeRoot(["report.docx"]);
    expect(await localFileExists(root, "report.conflict-2026-09-07-143204.docx")).toBe(false);
  });

  it("answers false when the directory itself is missing", async () => {
    expect(await localFileExists(fakeRoot(["report.docx"]), "nope/report.docx")).toBe(false);
  });

  it("never creates the directory it is only asking about", async () => {
    const created: string[] = [];
    const root = fakeRoot(["a/b/report.docx"]);
    const wrapped: DirHandle = {
      ...root,
      getDirectoryHandle: (name, opts) => { if (opts?.create) created.push(name); return root.getDirectoryHandle(name, opts); },
    };
    await localFileExists(wrapped, "a/b/x.txt");
    expect(created).toEqual([]);
  });
});

/** Strip the hash off a hashed manifest → the mtime+size shape `walkLocal` yields. */
function stat(m: HashedManifest): LocalManifest {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { mtime: v.mtime, size: v.size }]));
}
