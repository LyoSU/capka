import { createHash } from "node:crypto";

// The sandbox container's security posture lives here as a pure builder, so the
// guarantees (never privileged, no-new-privileges, all caps dropped, non-root,
// no host binds beyond the session workspace — except operator-confirmed
// /folders mounts validated by mount-safety) are unit-tested and cannot silently
// regress. server.js composes the runtime values and calls these.

/**
 * The platform decides egress per run (admin setting + per-project override) and
 * sends the requested mode. Only "bridge" grants network; anything else — and any
 * unrecognized request (e.g. "host") — resolves to "none" (no network).
 */
export function resolveNetworkMode(requested) {
  return requested === "bridge" ? "bridge" : "none";
}

/** Every knob a DEPLOYMENT decides, by name — the contract between three places
 *  that must agree and have twice failed to: server.js builds SPEC_ENV from these,
 *  DockerBackend.create() must forward each one, and fingerprint() hashes what they
 *  produce. create()'s field list is explicit on purpose (it stops a caller
 *  smuggling arbitrary container config), which is exactly why a new knob is inert
 *  until someone remembers to name it there — that happened to `egressProxy` and
 *  then to `homeMb`. server.js refuses to boot if SPEC_ENV drifts from this list,
 *  and docker-backend.test.js proves create() forwards every entry.
 *
 *  Note what is NOT here: readonlyRootfs, sandboxUser, image, runtime and the
 *  session fields are not deployment knobs the server sends per session. */
export const DEPLOYMENT_KNOBS = [
  "memoryBytes",
  "nanoCpus",
  "pidsLimit",
  "tmpMb",
  "mcpTmpMb",
  "homeMb",
  "mcpUid",
  "mcpGid",
  "fsizeBytes",
];

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
  // gVisor's host-side runtime threads count toward Docker's pids cgroup. A
  // limit of 100 leaves too little headroom for normal image/document renderers
  // (ImageMagick, Chromium, LibreOffice) and can surface as misleading ENOMEM
  // errors from unrelated helpers such as tail/xargs. 256 still contains fork
  // bombs while leaving a useful workload budget across runc and runsc.
  pidsLimit = 256,
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
  // The agent's HOME. It is NOT optional decoration: with readonlyRootfs the
  // image's /home/sandbox is immutable, and both LibreOffice and Chromium create a
  // profile under $HOME before they do anything else — so `soffice --convert-to
  // pdf` and the html2pdf shim produced NOTHING at all, which is the product's
  // core "drop a file in, get a converted file back" promise failing silently.
  homeMb = 64,
  // The uid/gid the MCP bridge execs stdio connectors under (server.js resolves
  // them from SANDBOX_MCP_UID/GID; the `mcp` user baked into the image is 1001).
  // They own /opt/mcp — see the Tmpfs block for why that ownership is load-bearing.
  mcpUid = 1001,
  mcpGid = 1001,
  // Operator-confirmed host folders, bind-mounted at /folders/<name>. Each entry
  // is {hostPath, name, ro}; hostPath has already passed mount-safety validation
  // in server.js. Deliberately OUTSIDE /workspace so the quota/prune/delete_path
  // machinery never touches the operator's files. Empty by default (zero-config).
  mounts = [],
  // `host:port` of the egress proxy when an allowlist is configured, else null.
  // Its presence — not the network mode's name — is what switches this container
  // from "public internet minus the private ranges" to "nothing but the proxy".
  egressProxy = null,
}) {
  const config = {
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
      // XTABLES_LOCKFILE: iptables-legacy defaults its lock to /run/xtables.lock,
      // but the rootfs is read-only and /run isn't a writable mount — so the lock
      // open fails and the fail-closed egress firewall kills the container. Point
      // it at the writable /tmp tmpfs. (Only meaningful alongside the firewall.)
      ...(networkMode !== "none" ? ["SANDBOX_EGRESS_FILTER=1", "XTABLES_LOCKFILE=/tmp/xtables.lock"] : []),
      // Default-deny mode. SANDBOX_EGRESS_PROXY tells the entrypoint to permit
      // nothing but this endpoint; the rest teaches the toolchain to use it.
      //
      // HTTPS_PROXY only, and deliberately no HTTP_PROXY: the proxy speaks CONNECT
      // and nothing else, so an http:// request must fail on the firewall rather
      // than arrive there as a shape it does not handle. Both cases are set because
      // curl reads only the lowercase form (a deliberate httpoxy defence) while
      // most other tools read the uppercase one.
      //
      // NODE_USE_ENV_PROXY is what makes Node's BUILT-IN fetch honour it (the
      // image ships Node 22.23, which has it; older 22.x does not) — without it
      // every fetch() in execute_node would just hit the firewall. The paired
      // --disable-warning keeps its experimental notice out of every tool result.
      // The JVM reads no proxy env var at all, hence JAVA_TOOL_OPTIONS.
      ...(egressProxy
        ? [
            `SANDBOX_EGRESS_PROXY=${egressProxy}`,
            `HTTPS_PROXY=http://${egressProxy}`,
            `https_proxy=http://${egressProxy}`,
            "NO_PROXY=localhost,127.0.0.1",
            "no_proxy=localhost,127.0.0.1",
            "NODE_USE_ENV_PROXY=1",
            "NODE_OPTIONS=--disable-warning=UNDICI-EHPA",
            `JAVA_TOOL_OPTIONS=-Dhttps.proxyHost=${egressProxy.split(":")[0]} -Dhttps.proxyPort=${egressProxy.split(":")[1] ?? "3128"}`,
          ]
        : []),
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
        //
        // Owned by the MCP uid, mode 0700 — NOT world-writable. This is the other
        // half of the uid split server.js enforces: /opt/mcp is the connectors'
        // HOME, so a world-writable mount let the agent (uid 1000) plant a
        // ~/.bash_profile that the next connector start would source AS the MCP
        // user, with its decoded secrets in the environment — walking straight
        // around the boundary /proc hardening is there to protect. uid/gid/mode are
        // ordinary tmpfs mount options, so the kernel applies them at mount time
        // and no entrypoint step (or extra capability) can forget to.
        "/opt/mcp": `rw,nosuid,nodev,exec,size=${mcpTmpMb}m,mode=0700,uid=${mcpUid},gid=${mcpGid}`,
        // The agent's own HOME, 0700 and owned by uid 1000 via mount options for the
        // same reason /opt/mcp is: the kernel applies them at mount time, so no
        // entrypoint step can forget it and no capability is needed.
        //
        // `exec`, unlike /tmp. That is not a relaxation: /workspace is a bind mount
        // with no noexec option, so the agent can already run a binary it writes
        // there — noexec here would buy nothing while half-breaking the ordinary
        // `pip install --user` / `npx` / `uvx` flows, whose console scripts land in
        // ~/.local/bin and would fail to execute.
        "/home/sandbox": `rw,nosuid,nodev,exec,size=${homeMb}m,mode=0700,uid=1000,gid=1000`,
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
      CapAdd: ["CHOWN", "SETUID", "SETGID", ...(networkMode !== "none" ? ["NET_ADMIN", "NET_RAW"] : [])],
      NetworkMode: networkMode,
      Binds: [`${wsHostPath}:/workspace`, `${sharedHostPath}:/shared`],
      // Host folders use Mounts (not Binds): Mounts fails on a missing source
      // instead of silently creating a root-owned dir, and carries explicit
      // ReadOnly + Propagation. rprivate stops mount events propagating either way.
      ...(mounts.length ? { Mounts: mounts.map((m) => ({
        Type: "bind", Source: m.hostPath, Target: `/folders/${m.name}`,
        ReadOnly: m.ro !== false, BindOptions: { Propagation: "rprivate" },
      })) } : {}),
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
  // Stamped last, from the config above: the posture this container was actually
  // built with, so boot reconciliation can spot one built by an older, weaker spec.
  config.Labels["capka.spec"] = specFingerprint(config);
  return config;
}

/**
 * A short, stable hash of the container's SECURITY POSTURE — everything that makes
 * a sandbox a sandbox, and nothing that differs between two sessions on the same
 * deployment.
 *
 * It exists because these settings are fixed at CREATE time: mount options, caps,
 * the read-only rootfs and the runtime cannot be changed on a live container. A
 * hardening fix therefore reaches an already-running sandbox only if something
 * notices that sandbox predates it — this label is how reconcile notices. A
 * container with no `capka.spec` label at all predates the mechanism itself, and
 * counts as outdated for exactly the same reason.
 *
 * Anything added to the posture belongs in this list. Session-varying fields (name,
 * labels, binds, network mode, workspace paths) are deliberately out: including one
 * would make every container's fingerprint unique and the comparison meaningless.
 */
export function specFingerprint(config) {
  const posture = {
    Image: config.Image,
    User: config.User,
    ReadonlyRootfs: config.HostConfig.ReadonlyRootfs,
    Privileged: config.HostConfig.Privileged,
    SecurityOpt: config.HostConfig.SecurityOpt,
    CapDrop: config.HostConfig.CapDrop,
    CapAdd: config.HostConfig.CapAdd,
    Tmpfs: config.HostConfig.Tmpfs,
    Runtime: config.HostConfig.Runtime ?? null,
    PidsLimit: config.HostConfig.PidsLimit,
    Ulimits: config.HostConfig.Ulimits,
    // Both belong here, and their absence was a hole: the whole egress posture
    // lives in Env (SANDBOX_EGRESS_FILTER, SANDBOX_EGRESS_PROXY) and in which
    // network the container joined. Two different networks can carry identical
    // caps, so without these a container built before an allowlist existed looks
    // posture-identical to one built after it, and keeps its open egress until
    // something else happens to recreate it. Env holds no session-specific value
    // (see the Env block), so this stays comparable across sessions.
    Env: config.Env,
    NetworkMode: config.HostConfig.NetworkMode,
  };
  return createHash("sha256").update(JSON.stringify(posture)).digest("hex").slice(0, 16);
}
