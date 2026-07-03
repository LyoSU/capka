import { describe, it, expect } from "vitest";
import { buildSandboxConfig, resolveNetworkMode } from "./sandbox-spec.js";

const base = {
  image: "capka-sandbox",
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

  it("grants NET_ADMIN *and* NET_RAW for the egress firewall when networking is on", () => {
    // The entrypoint's iptables firewall needs NET_ADMIN to write rules and NET_RAW
    // for the rules' `filter` table to initialize — under gVisor (CapDrop ALL means
    // nothing is inherited) the table can't exist without NET_RAW, so the firewall
    // fails closed and the container dies. Both are dropped again at the setpriv-drop.
    expect(buildSandboxConfig({ ...base, networkMode: "bridge" }).HostConfig.CapAdd)
      .toEqual(["CHOWN", "SETUID", "SETGID", "NET_ADMIN", "NET_RAW"]);
  });

  it("points iptables at a writable lock file when networking is on (/run is read-only)", () => {
    // ReadonlyRootfs means iptables-legacy can't create its default /run/xtables.lock;
    // redirect it to the writable /tmp tmpfs or the fail-closed firewall dies on startup.
    expect(buildSandboxConfig({ ...base, networkMode: "bridge" }).Env).toContain("XTABLES_LOCKFILE=/tmp/xtables.lock");
    // Not set when there's no firewall to run.
    expect(buildSandboxConfig(base).Env).not.toContain("XTABLES_LOCKFILE=/tmp/xtables.lock");
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

  it("mounts become read-only rprivate bind Mounts under /folders", () => {
    const cfg = buildSandboxConfig({ ...base, mounts: [
      { hostPath: "/srv/share", name: "share", ro: true },
      { hostPath: "/mnt/nas/x", name: "nas", ro: false },
    ]});
    expect(cfg.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: "/srv/share", Target: "/folders/share", ReadOnly: true,
        BindOptions: { Propagation: "rprivate" } },
      { Type: "bind", Source: "/mnt/nas/x", Target: "/folders/nas", ReadOnly: false,
        BindOptions: { Propagation: "rprivate" } },
    ]);
  });

  it("no mounts -> no Mounts key (config identical to today)", () => {
    expect(buildSandboxConfig(base).HostConfig.Mounts).toBeUndefined();
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

describe("buildSandboxConfig — resource exhaustion limits", () => {
  it("caps open file descriptors (nofile) to contain FD-exhaustion DoS", () => {
    // Default ulimit -n is ~1M; a malicious process can open hundreds of
    // thousands of FDs and destabilize the container's own processes (the
    // runner, on-demand render servers) and starve sibling sandboxes on the host.
    const nofile = (buildSandboxConfig(base).HostConfig.Ulimits || []).find((u) => u.Name === "nofile");
    expect(nofile).toBeDefined();
    expect(nofile.Hard).toBeLessThanOrEqual(65536);
    expect(nofile.Soft).toBeLessThanOrEqual(nofile.Hard);
  });

  it("allows tuning the nofile limit", () => {
    const nofile = buildSandboxConfig({ ...base, nofileLimit: 1024 }).HostConfig.Ulimits.find((u) => u.Name === "nofile");
    expect(nofile.Soft).toBe(1024);
    expect(nofile.Hard).toBe(1024);
  });

  it("caps single-file size (fsize) to kill a one-command disk bomb mid-write", () => {
    // RLIMIT_FSIZE is kernel-enforced and synchronous: `fallocate -l 100G` /
    // `dd` / `truncate` past the cap fail with EFBIG instantly — the one defense
    // the poll-based workspace quota can't provide (it only blocks the NEXT exec).
    const fsize = buildSandboxConfig({ ...base, fsizeBytes: 500 * 1024 * 1024 }).HostConfig.Ulimits.find((u) => u.Name === "fsize");
    expect(fsize).toBeDefined();
    expect(fsize.Soft).toBe(500 * 1024 * 1024);
    expect(fsize.Hard).toBe(500 * 1024 * 1024);
  });

  it("omits the fsize ulimit when no cap is given (off unless the controller sets it)", () => {
    const fsize = (buildSandboxConfig(base).HostConfig.Ulimits || []).find((u) => u.Name === "fsize");
    expect(fsize).toBeUndefined();
  });

  it("pins MemorySwap to Memory so swap can't be used to exceed the RAM cap", () => {
    // Without this, Docker defaults memory+swap to 2× memory, letting a process
    // spill past the 384MB cap into swap and evade the OOM limit.
    const c = buildSandboxConfig(base);
    expect(c.HostConfig.MemorySwap).toBe(base.memoryBytes);
  });
});

describe("buildSandboxConfig — tunable tmpfs sizing", () => {
  // tmpfs pages are charged against the container's memory cgroup, so /tmp +
  // /opt/mcp sizes eat into memoryBytes. They must be tunable per deployment so
  // an operator can right-size them against the Memory budget instead of having
  // a single process fill a hardcoded 64m /tmp and brick the session.
  it("defaults /tmp and /opt/mcp to their conservative sizes", () => {
    const t = buildSandboxConfig(base).HostConfig.Tmpfs;
    expect(t["/tmp"]).toContain("size=64m");
    expect(t["/opt/mcp"]).toContain("size=256m");
  });

  it("lets the operator resize /tmp", () => {
    const t = buildSandboxConfig({ ...base, tmpMb: 256 }).HostConfig.Tmpfs;
    expect(t["/tmp"]).toContain("size=256m");
    // resizing must not weaken the hardening flags
    expect(t["/tmp"]).toContain("noexec");
    expect(t["/tmp"]).toContain("nosuid");
  });

  it("lets the operator resize the exec-allowed /opt/mcp tmpfs", () => {
    const t = buildSandboxConfig({ ...base, mcpTmpMb: 128 }).HostConfig.Tmpfs;
    expect(t["/opt/mcp"]).toContain("size=128m");
    expect(t["/opt/mcp"]).toContain("exec");
  });
});

describe("resolveNetworkMode — platform decides; only bridge grants network", () => {
  it("grants bridge when the platform requests it", () => {
    expect(resolveNetworkMode("bridge")).toBe("bridge");
  });

  it("never grants anything but none for other/unknown modes", () => {
    expect(resolveNetworkMode("none")).toBe("none");
    expect(resolveNetworkMode("host")).toBe("none");
    expect(resolveNetworkMode(undefined)).toBe("none");
  });
});
