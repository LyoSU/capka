// The sandbox container's security posture lives here as a pure builder, so the
// guarantees (never privileged, no-new-privileges, all caps dropped, non-root,
// no host binds beyond the session workspace) are unit-tested and cannot silently
// regress. server.js composes the runtime values and calls these.

/**
 * Bridge networking is opt-in: a sandbox gets real network access ONLY when the
 * operator explicitly enabled it (SANDBOX_ALLOW_NETWORK). Everything else — and
 * any unrecognized request — resolves to "none" (no network).
 */
export function resolveNetworkMode(requested, { allowNetwork = false } = {}) {
  return allowNetwork && requested === "bridge" ? "bridge" : "none";
}

/** Build the full dockerode createContainer config for a sandbox. */
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
}) {
  return {
    Image: image,
    name: `sandbox-${sessionId}`,
    Env: ["DISPLAY=:99", "PYTHONUNBUFFERED=1", "LANG=C.UTF-8"],
    HostConfig: {
      Memory: memoryBytes,
      NanoCpus: nanoCpus,
      PidsLimit: pidsLimit,
      // Hard, non-negotiable isolation. Privileged is set explicitly so the
      // test pins it and a future edit can't omit it into a truthy default.
      Privileged: false,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      // Minimal caps for the boot sequence only: CHOWN lets the (root) entrypoint
      // fix ownership of the bind-mounted /workspace + /shared, and SETUID/SETGID
      // let it setpriv-drop to the unprivileged sandbox user. After the drop, and
      // for every agent command (exec runs as uid 1000), these buy nothing.
      CapAdd: ["CHOWN", "SETUID", "SETGID"],
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
      "unclaw.session": sessionId,
      "unclaw.user": userId,
      "unclaw.network": networkMode,
    },
  };
}
