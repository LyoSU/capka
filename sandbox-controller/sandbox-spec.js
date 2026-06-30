// The sandbox container's security posture lives here as a pure builder, so the
// guarantees (never privileged, no-new-privileges, all caps dropped, non-root,
// no host binds beyond the session workspace) are unit-tested and cannot silently
// regress. server.js composes the runtime values and calls these.

/**
 * The platform decides egress per run (admin setting + per-project override) and
 * sends the requested mode. Only "bridge" grants network; anything else — and any
 * unrecognized request (e.g. "host") — resolves to "none" (no network).
 */
export function resolveNetworkMode(requested) {
  return requested === "bridge" ? "bridge" : "none";
}

/** Build the full dockerode createContainer config for a sandbox.
 *  `runtime` selects the OCI runtime (gVisor "runsc" by default in the secure
 *  profile; "runc" only for trusted/dev). `readonlyRootfs` makes the container's
 *  root filesystem immutable with a writable tmpfs at /tmp — strong hardening, but
 *  workflows that write into the image rootfs (e.g. `pip install` into system
 *  site-packages) must use /workspace or a venv; validate via the §9 workload matrix
 *  before assuming a given image tolerates it. */
export function buildSandboxConfig({
  image,
  sessionId,
  userId,
  wsHostPath,
  sharedHostPath,
  networkMode = "none",
  memoryBytes,
  nanoCpus,
  pidsLimit = 100,
  nofileLimit = 65536,
  // Max bytes any single file may reach (RLIMIT_FSIZE). 0 = no cap. This is the
  // kernel-enforced, synchronous backstop the poll-based workspace quota lacks:
  // `fallocate -l 100G` / `dd` / `truncate` past the cap fail with EFBIG mid-write,
  // instead of slipping through as one command and only blocking the NEXT exec.
  fsizeBytes = 0,
  runtime,
  readonlyRootfs = true,
  // tmpfs sizes (MB). NOTE: tmpfs pages are charged against the container's
  // memory cgroup, so tmpMb + mcpTmpMb come OUT of memoryBytes — raising them
  // without raising Memory makes the container OOM sooner. Keep the sum well
  // under the memory budget. Tunable via SANDBOX_TMP_MB / SANDBOX_MCP_TMP_MB.
  tmpMb = 64,
  mcpTmpMb = 256,
}) {
  return {
    Image: image,
    name: `sandbox-${sessionId}`,
    // When egress is on (bridge), tell the entrypoint to install the egress
    // firewall that blocks private/internal ranges (see sandbox-entrypoint.sh).
    // No ambient DISPLAY: there's no persistent Xvfb to point at. GUI tools
    // (LibreOffice, wkhtmltopdf) render under a throwaway X server via the
    // `xvfb-run` shims in the image, which set their own DISPLAY per command.
    Env: [
      "PYTHONUNBUFFERED=1",
      "LANG=C.UTF-8",
      ...(networkMode === "bridge" ? ["SANDBOX_EGRESS_FILTER=1"] : []),
    ],
    HostConfig: {
      Memory: memoryBytes,
      // Pin total memory+swap to Memory so a process can't spill past the RAM cap
      // into swap and dodge the OOM limit (Docker otherwise defaults swap to 2×).
      MemorySwap: memoryBytes,
      NanoCpus: nanoCpus,
      PidsLimit: pidsLimit,
      // Cap open file descriptors. The image default (~1M) lets a malicious
      // process open hundreds of thousands of FDs and destabilize the container's
      // own processes (the runner, on-demand render servers) and starve sibling
      // sandboxes on the host.
      Ulimits: [
        { Name: "nofile", Soft: nofileLimit, Hard: nofileLimit },
        // Single-file size cap — the only synchronous defense against a one-shot
        // `fallocate -l 100G`. Omitted when 0 so it's off unless the controller sets it.
        ...(fsizeBytes > 0 ? [{ Name: "fsize", Soft: fsizeBytes, Hard: fsizeBytes }] : []),
      ],
      // OCI runtime: gVisor ("runsc") in the secure profile. Omitted when unset so
      // the daemon default applies (dev/bare runs). Fail-closed availability is
      // enforced at boot by runtime-check.js, not here.
      ...(runtime ? { Runtime: runtime } : {}),
      // Immutable rootfs + a small writable /tmp. The agent's writable surface is
      // the bind-mounted /workspace (+ /shared); everything else is read-only.
      ReadonlyRootfs: readonlyRootfs,
      // NOTE: /tmp is size-capped, but the bind-mounted /workspace is NOT — Docker
      // bind mounts can't carry a size limit. A sandbox can fill the shared host's
      // disk via /workspace; the controller's MAX_WORKSPACE_MB only bounds uploads
      // routed through it. Enforce disk at the host (XFS project quota on DATA_ROOT
      // or a per-session sized volume); the controller logs `workspace.over_quota`.
      // /tmp stays noexec (can't drop+run a binary there). /opt/mcp is a separate
      // exec-allowed tmpfs for stdio MCP servers that self-install (npx/uvx need to
      // execute the fetched binary). It's ephemeral (dies with the session) and
      // outside the agent's /workspace, so it never pollutes the user's files.
      Tmpfs: {
        "/tmp": `rw,nosuid,nodev,noexec,size=${tmpMb}m`,
        // `exec` is REQUIRED and explicit — Docker adds noexec to tmpfs by default,
        // which would stop npx/uvx-installed server binaries from running here.
        "/opt/mcp": `rw,nosuid,nodev,exec,size=${mcpTmpMb}m,mode=1777`,
      },
      // Hard, non-negotiable isolation. Privileged is set explicitly so the
      // test pins it and a future edit can't omit it into a truthy default.
      Privileged: false,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      // Minimal caps for the boot sequence only: CHOWN lets the (root) entrypoint
      // fix ownership of the bind-mounted /workspace + /shared, and SETUID/SETGID
      // let it setpriv-drop to the unprivileged sandbox user. When egress is on the
      // entrypoint installs the iptables firewall before the drop, which needs
      // NET_ADMIN (write rules) *and* NET_RAW — under gVisor, with CapDrop ALL, the
      // iptables `filter` table can't initialize without NET_RAW ("Table does not
      // exist"), so the firewall fails closed and the container dies on startup.
      // (NET_RAW is honored only when runsc itself runs with --net-raw=true; see
      // scripts/install-gvisor.sh.) After the setpriv-drop, and for every agent
      // command (exec runs as uid 1000 with no caps), these buy nothing.
      CapAdd: ["CHOWN", "SETUID", "SETGID", ...(networkMode === "bridge" ? ["NET_ADMIN", "NET_RAW"] : [])],
      NetworkMode: networkMode,
      Binds: [`${wsHostPath}:/workspace`, `${sharedHostPath}:/shared`],
      Init: true,
    },
    // Intentionally NO `User` pin. The container must start as the image default
    // (root) so the entrypoint can chown the host-created bind mounts before the
    // agent touches them — that repair is what makes /workspace reliably writable
    // regardless of how the host created the mount source. The entrypoint then
    // immediately drops to uid 1000, and execInSandbox pins every command to
    // 1000:1000, so no agent code ever runs as root.
    WorkingDir: "/workspace",
    Tty: false,
    Labels: {
      "capka.session": sessionId,
      "capka.user": userId,
      "capka.network": networkMode,
    },
  };
}
