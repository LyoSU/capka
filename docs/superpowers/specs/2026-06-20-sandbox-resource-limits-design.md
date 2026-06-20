# Sandbox resource limits & abuse hardening — design

**Date:** 2026-06-20
**Status:** Approved design (pending implementation plan)
**Area:** `sandbox-controller/` (controller + `sandbox-spec.js`), `Dockerfile.sandbox`/entrypoint, `docker-compose*.yml`

## Goal

Close the remaining **resource-abuse** gaps in the sandbox so a sandboxed AI
cannot exhaust host **RAM** or **disk**, while preserving the existing
cross-platform bind-mount architecture and the current security posture
(non-privileged, no-new-privileges, caps dropped, network off by default,
non-root exec). No regression to the path-traversal / auth defenses, which the
audit found solid.

## Audit summary (what is already covered)

These were reviewed and need **no change**:

- **Path traversal / escape** — `sanitize()` (id allow-list + length cap),
  `safeJoin()` (boundary check, not naive prefix), `safeRealPath()` (symlink
  re-containment). All file endpoints route through them; upload uses
  `basename()` + `safeJoin` on the target.
- **Auth** — Bearer secret with constant-time compare, refuses default/unset
  secret, HMAC workspace-token binds file ops to a `userId` with no live
  container.
- **Container isolation** — `Privileged:false`, `no-new-privileges`,
  `CapDrop:ALL` (+3 boot-only caps), `NetworkMode:none` default, exec pinned to
  uid 1000, `PidsLimit:100`, `Init:true` reaper, socket-proxy narrows the Docker
  API. Acknowledged as defense-in-depth, not a hard root boundary (rootless
  Docker remains the documented path to "escape ≠ host root").

## Gaps being fixed

| Vector | Current state | Fix |
|---|---|---|
| RAM swap | `Memory` set, `MemorySwap` unset → effective 2× via swap | `MemorySwap = Memory` (swap off, hard cap) |
| `/tmp`, container writable layer | unbounded; `dd` to `/tmp` fills host overlay | `Tmpfs` mount on `/tmp` with a size cap (kernel-enforced ENOSPC) |
| `/workspace` disk (agent writes) | quota checked **only** on upload | usage check at pre-exec + idle-loop |
| `/shared` disk | **no quota at all**, per-user, persists across sessions | included in the same usage accounting |
| No file delete | files can only be removed by the agent via `rm` | add `DELETE /files` (breaks the quota deadlock + fills a product gap) |

## Design

### 1. Hard RAM limit — `sandbox-spec.js` + `server.js`

`buildSandboxConfig` gains a `memorySwapBytes` parameter, written to
`HostConfig.MemorySwap`. `server.js` passes `MemorySwap = MEMORY_LIMIT` so swap
is disabled and the container cannot exceed its RAM ceiling; an over-budget
process is OOM-killed inside the container (does not touch the host).

Pinned in `sandbox-spec.test.js` so a future edit can't silently drop it (same
discipline already applied to `Privileged:false`).

### 2. Bounded `/tmp` — `sandbox-spec.js`

Add to `HostConfig`:

```js
Tmpfs: { "/tmp": `size=${tmpMb}m,mode=1777` }
```

- New env `SANDBOX_TMP_MB` (default **256**). Configurable, and parameterized
  through `buildSandboxConfig` (`tmpMb`) so it stays unit-tested.
- `mode=1777` keeps `/tmp` world-writable + sticky so the toolchain behaves.
- **Caveat (documented) — tmpfs is charged to RAM.** tmpfs pages count against
  the container's memory cgroup. With swap off (§1), the arithmetic is hard:
  **`/tmp` usage + process RSS ≤ `SANDBOX_MEMORY_MB`**, so a full `/tmp` leaves
  `MEMORY_MB − TMP_MB` for processes. The default pair (512 MB RAM / 256 MB tmp)
  leaves ≥256 MB for processes in the worst case. The heavy toolchain
  (LibreOffice, LaTeX, ffmpeg, Chromium) is both RAM- and `/tmp`-hungry, so
  operators running those workloads should raise `SANDBOX_MEMORY_MB` **and**
  `SANDBOX_TMP_MB` together (keeping tmp well below memory). This relationship is
  called out in README + compose comments.
- Residual: other writable-layer paths (`~`, `/var/tmp`) remain unbounded but are
  **ephemeral** (gone when the container is removed at idle-TTL). This is
  documented as a known limitation, with rootless Docker / xfs project quota as
  the hardening path — consistent with the existing security note in
  `docker-compose.yml`.

### 3. Persistent disk quota — `server.js`

**Accounting.** New helper:

```js
async function workspaceUsage(userId, sessionId) {
  return {
    workspace: await dirSize(workspacePath(userId, sessionId)),
    shared:    await dirSize(globalPath(userId)),
  };
}
```

Caps:
- `MAX_WORKSPACE_MB` (existing, default 500) → `/workspace`, per session.
- `MAX_SHARED_MB` (new, default = `MAX_WORKSPACE_MB`) → `/shared`, per user.

**Enforcement points:**

1. **pre-exec** (`POST /sessions/:id/exec`): measure usage; if `workspace` over
   its cap **or** `shared` over its cap, return `413` with a friendly,
   role-aware message (no jargon) and **do not** run the command. This stops the
   agent from launching further disk-growing work — the dominant vector, since
   the agent acts through exec.

2. **idle-loop** (existing `setInterval`, kept at 60s): for each live session,
   measure usage; if over cap, **stop** the container (halt runaway background
   writers spawned by an earlier `foo &`), keep the data and the session entry,
   and log a warning. The session is restartable; the pre-exec gate re-checks on
   the next command.

3. **upload** (existing): unchanged in spirit — keep the workspace check; it
   already returns `413` on overflow.

**Deadlock break — `DELETE /sessions/:id/files?path=` (new endpoint).**
A hard pre-exec block would otherwise trap the agent: it cannot run `rm` to
recover. We add a controller-side delete that operates via native fs
(`safeRealPath` containment, no exec needed), so space can be freed even when
exec is gated. This also fills a real product gap — today there is **no** way to
delete a workspace file except through the agent. The endpoint:
- auth + `resolveWsBase` (same token model as the other file endpoints),
- `safeRealPath(wsBase, path)` containment check,
- refuses to delete the workspace root itself,
- `rm -rf`-equivalent via `fs.rm({ recursive })` on the resolved path only.

**Why monitoring, not kernel quota.** A kernel-hard cap on the bind mount needs
xfs project quotas (not portable; fails on Docker Desktop / ext4) or per-user
loopback images (needs mount privilege the controller doesn't have). Software
`dirSize` polling is therefore the portable choice; its inherent looseness (a
single command can overshoot between checks) is bounded by the pre-exec gate
(blocks the *next* command) and the idle-loop stop (≤60s for background writers),
and is documented honestly.

### Error messages

All new user-facing errors (quota exceeded, file too large) follow the project
convention: friendly, plain-language, role-aware (end-user vs admin), localized
via the existing i18n. Controller returns a stable error `code`; the platform
maps it to a localized string. No raw jargon like "quota" or byte counts in the
end-user string.

## Configuration (new/changed env)

| Env | Default | Meaning |
|---|---|---|
| `SANDBOX_TMP_MB` | 256 | tmpfs size cap for `/tmp` (charged to container RAM; keep below `SANDBOX_MEMORY_MB`) |
| `MAX_SHARED_MB` | = `MAX_WORKSPACE_MB` | disk cap for per-user `/shared` |

Existing `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS`, `MAX_WORKSPACE_MB`,
`MAX_UPLOAD_MB`, `SANDBOX_IDLE_TTL_MS` are unchanged.

## Testing

- **`sandbox-spec.test.js`** (pure, no Docker): assert `MemorySwap === Memory`;
  assert `Tmpfs["/tmp"]` present with the configured size and `mode=1777`; assert
  defaults when params omitted. These guard against silent regression.
- **`path-safety` / new delete**: unit-test that `DELETE /files` containment
  rejects traversal and symlink escape, and refuses the workspace root.
- **Quota accounting**: unit-test `workspaceUsage` sums workspace + shared;
  test the pre-exec gate returns 413 over cap and passes under cap (logic
  extracted to a pure function where practical, mirroring `resolveNetworkMode`).
- Existing integration tests (`workspaces.integration.test.ts`) must still pass.

## Out of scope (YAGNI)

- xfs project quota / rootless Docker migration (documented as the hardening
  path, not implemented here).
- Per-command CPU/IO throttling beyond the existing `NanoCpus`.
- Upper bound on the platform-supplied `exec` timeout (trusted internal caller;
  noted as a minor follow-up only).

## Known limitations (documented, accepted)

1. Non-`/tmp` writable-layer paths are unbounded but ephemeral.
2. Persistent disk enforcement is poll-based, so a single command can transiently
   overshoot the cap before the next gate; bounded and documented.
