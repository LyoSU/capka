import { describe, it, expect } from "vitest";
import { planSync, type Manifest } from "../plan";

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
