import { describe, it, expect } from "vitest";
import { detectHostDataRoot } from "./local-fs-store.js";

const DATA = "/data/storage";

// A fake dockerode whose self-inspect returns the given Mounts (or throws).
const fakeDocker = (mounts, throwErr) => ({
  getContainer: () => ({
    inspect: async () => { if (throwErr) throw throwErr; return { Mounts: mounts }; },
  }),
});

describe("detectHostDataRoot", () => {
  it("returns an explicit override verbatim, without inspecting", async () => {
    const docker = { getContainer: () => { throw new Error("should not be called"); } };
    expect(await detectHostDataRoot(docker, { dataRoot: DATA, hostname: "x", override: "/host/path" }))
      .toBe("/host/path");
  });

  it("maps DATA_ROOT to the daemon-host source of its backing mount", async () => {
    const docker = fakeDocker([{ Destination: "/data", Source: "/var/lib/app/data" }]);
    expect(await detectHostDataRoot(docker, { dataRoot: DATA, hostname: "self" }))
      .toBe("/var/lib/app/data/storage");
  });

  it("prefers the most specific (deepest) matching mount", async () => {
    const docker = fakeDocker([
      { Destination: "/data", Source: "/shallow" },
      { Destination: "/data/storage", Source: "/deep/store" },
    ]);
    expect(await detectHostDataRoot(docker, { dataRoot: DATA, hostname: "self" }))
      .toBe("/deep/store");
  });

  it("falls back to dataRoot for a local daemon (failClosed off) when inspect fails", async () => {
    const docker = fakeDocker(null, new Error("no such container"));
    expect(await detectHostDataRoot(docker, { dataRoot: DATA, hostname: "self" })).toBe(DATA);
  });

  it("THROWS for a remote daemon (failClosed on) when self-inspect fails", async () => {
    const docker = fakeDocker(null, new Error("no such container"));
    await expect(detectHostDataRoot(docker, { dataRoot: DATA, hostname: "self", failClosed: true }))
      .rejects.toThrow(/could not resolve/i);
  });

  it("THROWS for a remote daemon (failClosed on) when no mount backs DATA_ROOT", async () => {
    const docker = fakeDocker([{ Destination: "/unrelated", Source: "/x" }]);
    await expect(detectHostDataRoot(docker, { dataRoot: DATA, hostname: "self", failClosed: true }))
      .rejects.toThrow(/could not resolve/i);
  });
});
