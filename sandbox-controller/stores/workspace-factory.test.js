import { describe, it, expect } from "vitest";
import { makeWorkspaceStore } from "./workspace-factory.js";
import { LocalFsStore } from "./local-fs-store.js";

describe("makeWorkspaceStore", () => {
  it("returns LocalFsStore for 'local'", () => {
    const s = makeWorkspaceStore({ kind: "local", dataRoot: "/tmp/x", uid: 1000, gid: 1000 });
    expect(s).toBeInstanceOf(LocalFsStore);
  });
  it("throws for unknown kind", () => {
    expect(() => makeWorkspaceStore({ kind: "s3", dataRoot: "/tmp/x" })).toThrow(/unknown.*store/i);
  });
});
