import { describe, it, expect } from "vitest";
import { hashCandidates, mergeHashed, type HashedManifest, type LocalManifest } from "../local-fs";

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

/** Strip the hash off a hashed manifest → the mtime+size shape `walkLocal` yields. */
function stat(m: HashedManifest): LocalManifest {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { mtime: v.mtime, size: v.size }]));
}
