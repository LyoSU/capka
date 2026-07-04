import { describe, it, expect } from "vitest";
import { planSync, planDirs, type Manifest } from "../plan";

// Helper: an entry with a hash (content identity) + mtime for LWW.
const e = (hash: string, mtime = 1, size = hash.length) => ({ hash, mtime, size });

describe("planSync — with a base (incremental)", () => {
  it("uploads a new local file", () => {
    const local: Manifest = { "a.txt": e("A") };
    expect(planSync(local, {}, {})).toMatchObject({ upload: ["a.txt"], download: [], deleteRemote: [], deleteLocal: [], conflicts: [] });
  });

  it("downloads a new remote file", () => {
    const remote: Manifest = { "b.txt": e("B") };
    expect(planSync({}, remote, {})).toMatchObject({ download: ["b.txt"], upload: [] });
  });

  it("propagates a one-sided local change", () => {
    const base: Manifest = { "a.txt": e("A") };
    const local: Manifest = { "a.txt": e("A2") };   // changed locally
    const remote: Manifest = { "a.txt": e("A") };    // unchanged
    expect(planSync(local, remote, base)).toMatchObject({ upload: ["a.txt"], download: [], conflicts: [] });
  });

  it("propagates a one-sided remote change", () => {
    const base: Manifest = { "a.txt": e("A") };
    const local: Manifest = { "a.txt": e("A") };
    const remote: Manifest = { "a.txt": e("A2") };
    expect(planSync(local, remote, base)).toMatchObject({ download: ["a.txt"], upload: [], conflicts: [] });
  });

  it("deletes on the server a file removed locally since base", () => {
    const base: Manifest = { "a.txt": e("A") };
    const remote: Manifest = { "a.txt": e("A") };
    expect(planSync({}, remote, base)).toMatchObject({ deleteRemote: ["a.txt"], deleteLocal: [] });
  });

  it("deletes locally a file removed on the server since base", () => {
    const base: Manifest = { "a.txt": e("A") };
    const local: Manifest = { "a.txt": e("A") };
    expect(planSync(local, {}, base)).toMatchObject({ deleteLocal: ["a.txt"], deleteRemote: [] });
  });

  it("flags a both-sided change as a conflict, newer mtime wins (tie → local)", () => {
    const base: Manifest = { "a.txt": e("A", 1) };
    const localNewer = planSync({ "a.txt": e("L", 5) }, { "a.txt": e("R", 3) }, base);
    expect(localNewer.conflicts).toEqual([{ path: "a.txt", winner: "local" }]);
    const remoteNewer = planSync({ "a.txt": e("L", 3) }, { "a.txt": e("R", 5) }, base);
    expect(remoteNewer.conflicts).toEqual([{ path: "a.txt", winner: "remote" }]);
    const tie = planSync({ "a.txt": e("L", 4) }, { "a.txt": e("R", 4) }, base);
    expect(tie.conflicts).toEqual([{ path: "a.txt", winner: "local" }]);
  });

  it("does nothing when both sides equal base", () => {
    const base: Manifest = { "a.txt": e("A") };
    const plan = planSync({ "a.txt": e("A") }, { "a.txt": e("A") }, base);
    expect(plan).toMatchObject({ upload: [], download: [], deleteRemote: [], deleteLocal: [], conflicts: [] });
  });

  it("propagates a same-LENGTH content edit when both sides carry a hash", () => {
    // Same byte length, different content — only the hash distinguishes them.
    // Without a server-side hash this silently reads as "already in sync" and
    // the edit never propagates (a data-loss-shaped bug), so the remote manifest
    // MUST carry a hash for this to work.
    const base: Manifest = { "a.txt": { hash: "OLD", mtime: 1, size: 4 } };
    const local: Manifest = { "a.txt": { hash: "NEW", mtime: 2, size: 4 } }; // edited locally
    const remote: Manifest = { "a.txt": { hash: "OLD", mtime: 1, size: 4 } };
    expect(planSync(local, remote, base)).toMatchObject({ upload: ["a.txt"], download: [], conflicts: [] });

    // …and the reverse (agent edited it in the workspace).
    const local2: Manifest = { "a.txt": { hash: "OLD", mtime: 1, size: 4 } };
    const remote2: Manifest = { "a.txt": { hash: "NEW", mtime: 2, size: 4 } };
    expect(planSync(local2, remote2, base)).toMatchObject({ download: ["a.txt"], upload: [] });
  });
});

describe("planSync — first sync (no base)", () => {
  it("unions local-only uploads and remote-only downloads", () => {
    const plan = planSync({ "a.txt": e("A") }, { "b.txt": e("B") }, null);
    expect(plan.upload).toEqual(["a.txt"]);
    expect(plan.download).toEqual(["b.txt"]);
  });

  it("identical content on both sides is a no-op", () => {
    const plan = planSync({ "a.txt": e("A") }, { "a.txt": e("A") }, null);
    expect(plan).toMatchObject({ upload: [], download: [], conflicts: [] });
  });

  it("different content on both sides with no base is a conflict", () => {
    const plan = planSync({ "a.txt": e("L", 2) }, { "a.txt": e("R", 1) }, null);
    expect(plan.conflicts).toEqual([{ path: "a.txt", winner: "local" }]);
  });
});

describe("planSync — excluded paths are never a delete signal", () => {
  // A path we deliberately skipped (oversized on one side) must not be read as a
  // deletion just because it's missing from that side's manifest. Leave it alone
  // entirely: no delete, no download that would clobber the user's big file.
  it("does not deleteRemote a file that went oversized locally (dropped from local)", () => {
    const base: Manifest = { "big.bin": e("A") };
    const remote: Manifest = { "big.bin": e("A") };
    // local dropped it (now > cap) → without the guard this is deleteRemote
    const plan = planSync({}, remote, base, new Set(["big.bin"]));
    expect(plan).toMatchObject({ deleteRemote: [], deleteLocal: [], upload: [], download: [] });
  });

  it("does not deleteLocal a file that went oversized on the server (dropped from remote)", () => {
    const base: Manifest = { "big.bin": e("A") };
    const local: Manifest = { "big.bin": e("A") };
    const plan = planSync(local, {}, base, new Set(["big.bin"]));
    expect(plan).toMatchObject({ deleteRemote: [], deleteLocal: [], upload: [], download: [] });
  });

  it("does not download/overwrite when a local file is excluded but present remotely", () => {
    const local: Manifest = {}; // excluded (oversized) → dropped from the walk
    const remote: Manifest = { "big.bin": e("A") };
    const plan = planSync(local, remote, null, new Set(["big.bin"]));
    expect(plan.download).toEqual([]);
  });

  it("leaves non-excluded files planned as usual", () => {
    const base: Manifest = { "a.txt": e("A"), "big.bin": e("B") };
    const remote: Manifest = { "a.txt": e("A"), "big.bin": e("B") };
    const plan = planSync({}, remote, base, new Set(["big.bin"]));
    expect(plan.deleteRemote).toEqual(["a.txt"]); // a.txt genuinely gone; big.bin protected
  });
});

describe("planDirs — directory 3-way (presence-based, no content)", () => {
  it("mirrors a new server dir to the PC (no base)", () => {
    expect(planDirs([], ["sub"], null)).toMatchObject({ createLocal: ["sub"], deleteRemote: [], deleteLocal: [] });
  });

  it("mirrors a new server dir to the PC (dir absent from base)", () => {
    expect(planDirs([], ["sub"], [])).toMatchObject({ createLocal: ["sub"], deleteRemote: [], deleteLocal: [] });
  });

  it("deletes on the server a dir removed on the PC since base", () => {
    // was synced (in base), still on server, gone locally → user deleted it on the PC
    expect(planDirs([], ["sub"], ["sub"])).toMatchObject({ deleteRemote: ["sub"], createLocal: [], deleteLocal: [] });
  });

  it("deletes on the PC a dir removed on the server since base", () => {
    expect(planDirs(["sub"], [], ["sub"])).toMatchObject({ deleteLocal: ["sub"], createLocal: [], deleteRemote: [] });
  });

  it("does nothing when a dir exists on both sides", () => {
    expect(planDirs(["sub"], ["sub"], ["sub"])).toMatchObject({ createLocal: [], deleteRemote: [], deleteLocal: [] });
  });

  it("does not resurrect a new empty local dir (no server mkdir path)", () => {
    // new empty dir on the PC, no base, not on server → nothing to do (out of scope, no endpoint)
    expect(planDirs(["sub"], [], null)).toMatchObject({ createLocal: [], deleteRemote: [], deleteLocal: [] });
  });

  it("sorts nested dirs parent-before-child for safe recursive apply", () => {
    expect(planDirs([], ["a/b", "a"], ["a/b", "a"])).toMatchObject({ deleteRemote: ["a", "a/b"] });
  });
});
