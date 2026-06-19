import { describe, it, expect } from "vitest";
import { buildSandboxConfig, resolveNetworkMode } from "./sandbox-spec.js";

const base = {
  image: "unclaw-sandbox",
  sessionId: "sess1",
  userId: "user1",
  wsHostPath: "/data/storage/user1/sess1/sandbox",
  sharedHostPath: "/data/storage/user1/_global/sandbox",
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 1e9,
};

describe("buildSandboxConfig — locked security posture", () => {
  it("is never privileged", () => {
    expect(buildSandboxConfig(base).HostConfig.Privileged).toBe(false);
  });

  it("always sets no-new-privileges", () => {
    expect(buildSandboxConfig(base).HostConfig.SecurityOpt).toContain("no-new-privileges");
  });

  it("drops ALL capabilities", () => {
    expect(buildSandboxConfig(base).HostConfig.CapDrop).toEqual(["ALL"]);
  });

  it("runs as the non-root sandbox user", () => {
    expect(buildSandboxConfig(base).User).toBe("1000:1000");
  });

  it("mounts exactly the per-session workspace and shared dir — no other host binds", () => {
    expect(buildSandboxConfig(base).HostConfig.Binds).toEqual([
      "/data/storage/user1/sess1/sandbox:/workspace",
      "/data/storage/user1/_global/sandbox:/shared",
    ]);
  });
});

describe("resolveNetworkMode — bridge is opt-in, default deny", () => {
  it("denies bridge by default (no network)", () => {
    expect(resolveNetworkMode("bridge", { allowNetwork: false })).toBe("none");
  });

  it("permits bridge only when the operator opted in", () => {
    expect(resolveNetworkMode("bridge", { allowNetwork: true })).toBe("bridge");
  });

  it("never grants anything but none for unknown modes", () => {
    expect(resolveNetworkMode("host", { allowNetwork: true })).toBe("none");
    expect(resolveNetworkMode(undefined, { allowNetwork: true })).toBe("none");
  });
});
