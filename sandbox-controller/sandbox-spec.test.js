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

  it("adds back only the minimal caps needed to fix mount ownership then drop privileges", () => {
    // The entrypoint runs as root just long enough to chown the bind mounts to the
    // sandbox user, then setpriv-drops to uid 1000. CHOWN = chown the mounts;
    // SETUID/SETGID = drop to the unprivileged user. Nothing else is needed, so
    // nothing else is granted. Pinning this set stops a future edit from quietly
    // widening the container's privileges.
    expect(buildSandboxConfig(base).HostConfig.CapAdd).toEqual(["CHOWN", "SETUID", "SETGID"]);
  });

  it("does NOT pin the container user — the entrypoint needs root to chown mounts, then drops to 1000", () => {
    // The persistent process and every `docker exec` (the agent's actual commands)
    // run as uid 1000 — that's enforced by the entrypoint's privilege drop and by
    // execInSandbox's `User: "1000:1000"`. The container itself must start as the
    // image's default (root) so the entrypoint can repair /workspace ownership;
    // a fixed non-root User here would reintroduce the EACCES bug it exists to fix.
    expect(buildSandboxConfig(base).User).toBeUndefined();
  });

  it("mounts exactly the per-session workspace and shared dir — no other host binds", () => {
    expect(buildSandboxConfig(base).HostConfig.Binds).toEqual([
      "/data/storage/user1/sess1/sandbox:/workspace",
      "/data/storage/user1/_global/sandbox:/shared",
    ]);
  });
});

describe("buildSandboxConfig — isolation hardening", () => {
  it("sets the configured runtime", () => {
    expect(buildSandboxConfig({ ...base, runtime: "runsc" }).HostConfig.Runtime).toBe("runsc");
  });

  it("omits Runtime when unset (daemon default)", () => {
    expect(buildSandboxConfig(base).HostConfig.Runtime).toBeUndefined();
  });

  it("read-only rootfs with a writable /tmp tmpfs by default", () => {
    const c = buildSandboxConfig({ ...base, runtime: "runsc" });
    expect(c.HostConfig.ReadonlyRootfs).toBe(true);
    expect(c.HostConfig.Tmpfs).toHaveProperty("/tmp");
  });

  it("allows opting out of read-only rootfs (for images that need a writable rootfs)", () => {
    expect(buildSandboxConfig({ ...base, readonlyRootfs: false }).HostConfig.ReadonlyRootfs).toBe(false);
  });

  it("applies the configured pids limit", () => {
    expect(buildSandboxConfig({ ...base, pidsLimit: 256 }).HostConfig.PidsLimit).toBe(256);
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
