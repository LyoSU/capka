import { createServer } from "node:http";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import Docker from "dockerode";
import pg from "pg";
import { sanitize } from "./path-safety.js";
import { resolveOwnerDecision, safeEqual } from "./owner.js";
import { parseMultipart } from "./multipart.js";
import { resolveNetworkMode } from "./sandbox-spec.js";
import { validateMountPath } from "./mount-safety.js";
import { makeComputeBackend } from "./backends/backend-factory.js";
import { makeWorkspaceStore } from "./stores/workspace-factory.js";
import { detectHostDataRoot } from "./stores/local-fs-store.js";
import { PostgresSessionStore } from "./session-store.js";
import { assertRuntimeAvailable } from "./runtime-check.js";
import { resolveRuntimeProfile } from "./profile.js";
import { reconcile } from "./reconcile.js";
import { gcOrphanWorkspaces, findOverQuota, reapStaleWorkspaces, quotaWarnings, reclaimRegenerable } from "./gc.js";
import { createQuotaTracker } from "./workspace-quota.js";
import { pickLruVictim } from "./session-policy.js";
import { notReadyGuard } from "./readiness.js";
import { withRetry } from "./retry.js";
import { createMcpBridge } from "./mcp-bridge.js";
import { streamArchive } from "./archive-stream.js";
import { log } from "./log.js";
import { createGracefulShutdown, installShutdownHandlers } from "./shutdown.js";

// --- Talk to the Docker API via DOCKER_HOST (socket-proxy) when set. ---
const docker = process.env.DOCKER_HOST
  ? new Docker()
  : new Docker({ socketPath: "/var/run/docker.sock" });

const PORT = process.env.PORT || 3001;
const SECRET = process.env.CONTROLLER_SECRET;

// Root-equivalent service: refuse to boot without a strong secret.
const DEFAULT_SECRET = "capka-sandbox-secret";
if (!SECRET || (SECRET === DEFAULT_SECRET && process.env.ALLOW_DEFAULT_SECRET !== "true")) {
  console.error(
    "[sandbox-controller] FATAL: CONTROLLER_SECRET is unset or left at the default value.\n" +
    "  Generate a strong secret and set it on both controller and platform: openssl rand -hex 32",
  );
  process.exit(1);
}

// Parse a non-negative integer env var that gates a security control. Unset →
// documented default. Present-but-garbage → FAIL CLOSED (throw at boot): a quota
// silently disabled by `parseInt("abc") === NaN` would leave the disk-bomb guard
// off without anyone noticing. Refuse to start instead.
function intEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`[sandbox-controller] FATAL: ${name}="${raw}" is not a non-negative integer.`);
    process.exit(1);
  }
  return n;
}

// Same fail-closed contract as intEnv, but for values that must be strictly
// positive (limits, timeouts, sizes, counts) — a typo'd `parseInt("30s")` used to
// yield NaN and silently break the comparison it fed. Unset → default.
function posIntEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[sandbox-controller] FATAL: ${name}="${raw}" is not a positive integer.`);
    process.exit(1);
  }
  return n;
}

// Positive float (e.g. CPU count). Same fail-closed contract.
function posFloatEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[sandbox-controller] FATAL: ${name}="${raw}" is not a positive number.`);
    process.exit(1);
  }
  return n;
}

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "capka-sandbox";
const TMP_MB = posIntEnv("SANDBOX_TMP_MB", 64);
const MCP_TMP_MB = posIntEnv("SANDBOX_MCP_TMP_MB", 256);
const MEMORY_LIMIT = posIntEnv("SANDBOX_MEMORY_MB", 512) * 1024 * 1024;
const PIDS_LIMIT = posIntEnv("SANDBOX_PIDS_LIMIT", 256);
const CPU_LIMIT = posFloatEnv("SANDBOX_CPUS", 1.0) * 1e9;
const EXEC_TIMEOUT = posIntEnv("SANDBOX_EXEC_TIMEOUT_MS", 30000);
const IDLE_TTL = posIntEnv("SANDBOX_IDLE_TTL_MS", 900000); // 15 min — stop idle CONTAINER (files stay)
const WORKSPACE_TTL_MS = posIntEnv("WORKSPACE_TTL_MS", 2592000000); // 30d — delete a workspace (row + disk) unused this long
const DATA_ROOT = process.env.DATA_ROOT || "/data/storage";
// Optional hard perimeter for host folder mounts: when set (`:`-separated roots),
// only paths under one of these may be mounted. Unset ⇒ any path passing the
// denylist is allowed, with the in-chat admin confirm as the final gate.
const MOUNT_ALLOW_ROOTS = (process.env.SANDBOX_MOUNT_ALLOW || "").split(":").filter(Boolean);
const MAX_SESSIONS_PER_USER = posIntEnv("MAX_SESSIONS_PER_USER", 5);
const MAX_WORKSPACE_MB = intEnv("MAX_WORKSPACE_MB", 500);
// Hard per-file size cap (RLIMIT_FSIZE), kernel-enforced. Defaults to the whole
// workspace budget: no single file may exceed the total quota anyway, and this
// stops a one-command disk bomb (`fallocate -l 100G`) that the poll-based quota
// can't catch until the NEXT exec. Set MAX_FILE_MB=0 to disable.
const MAX_FILE_MB = intEnv("MAX_FILE_MB", MAX_WORKSPACE_MB);
// How long a measured workspace size is trusted before re-walking the tree. Keeps
// the expensive du off the hot exec path and coalesces command bursts.
const QUOTA_CACHE_TTL_MS = intEnv("QUOTA_CACHE_TTL_MS", 5000);
const MAX_UPLOAD_MB = posIntEnv("MAX_UPLOAD_MB", 100);
const SANDBOX_UID = intEnv("SANDBOX_UID", 1000);
const SANDBOX_GID = intEnv("SANDBOX_GID", 1000);
const GC_GRACE_MS = posIntEnv("GC_GRACE_MS", 3600000); // 1h
const FLUSH_INTERVAL_MS = posIntEnv("FLUSH_INTERVAL_MS", 60000);
// The over-quota breach is advisory (ops alerting only) — no need to `du` every
// live workspace each minute. Scan on a slow cadence and warn once per crossing.
const OVER_QUOTA_SCAN_MS = posIntEnv("OVER_QUOTA_SCAN_MS", 600000); // 10min
// Before warning, try to reclaim space from regenerable deps (node_modules,
// .venv, __pycache__, …) in workspaces that are over quota AND have sat idle this
// long with their container stopped — safe because nothing's using the deps and
// they reinstall on the next run. Only over-quota workspaces (which can't run
// until freed anyway) ever pay that reinstall. The 30d whole-workspace reap is
// the harder backstop; this is the gentler, files-preserving step.
const REGEN_REAP_IDLE_MS = posIntEnv("REGEN_REAP_IDLE_MS", 86400000); // 1d
// Deployment-level egress kill-switch. The platform resolves a per-run mode
// (org default + per-project "bridge"), but a deployment that never sets
// SANDBOX_ALLOW_NETWORK=true gets NO network for any sandbox, regardless of what
// a user picks on their project. This is the gate the platform's settings/runner
// comments promise — without it those comments lied and a normal user could open
// egress a deployment meant to forbid. Off by default = fail-closed.
const ALLOW_NETWORK = process.env.SANDBOX_ALLOW_NETWORK === "true";

// Isolation: gVisor is OPT-IN. Default runtime is runc (boots on any Docker host);
// set SANDBOX_RUNTIME=runsc to opt into the fail-closed "secure" profile.
const { runtime: RUNTIME, profile: PROFILE } = resolveRuntimeProfile({
  runtime: process.env.SANDBOX_RUNTIME,
  profile: process.env.SANDBOX_PROFILE,
});
const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND || "docker";
const WORKSPACE_STORE = process.env.WORKSPACE_STORE || "local";
const DATABASE_URL = process.env.DATABASE_URL;

// --- Wiring (set during boot) ---
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const store = new PostgresSessionStore({ pool });
// Bridges stdio MCP servers (run via `docker exec` inside the sandbox) to the
// platform. They run under a SEPARATE uid from the agent (1000) so agent code
// can't read an MCP server's secret env via /proc/<pid>/environ. The `mcp` user
// (1001) is baked into the sandbox image.
const MCP_UID = intEnv("SANDBOX_MCP_UID", 1001);
const MCP_GID = intEnv("SANDBOX_MCP_GID", 1001);
// The isolation above only holds if the MCP uid is non-root AND distinct from the
// agent's uid. Root would let an MCP server escape the uid boundary; the same uid
// as the agent would let agent code read the server's secret env. Refuse to boot
// on a misconfiguration rather than run with the isolation comment quietly false.
if (!(MCP_UID > 0 && MCP_UID !== SANDBOX_UID)) {
  console.error(
    `[sandbox-controller] FATAL: SANDBOX_MCP_UID must be > 0 and != SANDBOX_UID (${SANDBOX_UID}); got ${MCP_UID}.`,
  );
  process.exit(1);
}
const mcpBridge = createMcpBridge(docker, { user: `${MCP_UID}:${MCP_GID}` });
let workspace;
let backend;
let hostDataRoot; // real host path of DATA_ROOT, resolved at boot; used by mount validation
let ready = false;
let liveCount = 0;
const maintenanceTimers = new Set();

// App-level disk-quota guard. The `size` closure reads the module-level
// `workspace` lazily, so it picks up the real store after boot (and the fake one
// injected by tests via __setTestState). See workspace-quota.js for the why.
const quota = createQuotaTracker({
  size: (userId, sessionId) => workspace.size(userId, sessionId),
  limitBytes: MAX_WORKSPACE_MB * 1024 * 1024,
  ttlMs: QUOTA_CACHE_TTL_MS,
});

/** Resolve the owner of a file op: a platform-supplied userId backed by a valid
 *  HMAC token bound to userId+sessionId — required whether the session is live or
 *  stopped, and (for a live session) cross-checked against its pinned owner.
 *  Decision logic is pure + unit-tested in owner.js. */
async function resolveOwner(sessionId, fallbackUserId, token) {
  const session = await store.get(sessionId);
  return resolveOwnerDecision({ session, sessionId, fallbackUserId, token, secret: SECRET });
}

// --- On-disk workspace listing (for GC). Skips the per-user _global shared dir. ---
// Validate every raw FS name here, at the read point: a dir whose name doesn't
// round-trip through sanitize() was never created by our store (our ids are already
// sanitized), so it's untrusted junk — skip it rather than feed it back into a
// remove() path. Don't rely on the store re-sanitizing later.
async function listWorkspacesOnDisk() {
  const out = [];
  const users = await readdir(DATA_ROOT, { withFileTypes: true }).catch(() => []);
  for (const u of users) {
    if (!u.isDirectory() || sanitize(u.name) !== u.name) continue;
    const sessions = await readdir(join(DATA_ROOT, u.name), { withFileTypes: true }).catch(() => []);
    for (const s of sessions) {
      if (!s.isDirectory() || s.name === "_global" || sanitize(s.name) !== s.name) continue;
      const st = await stat(join(DATA_ROOT, u.name, s.name)).catch(() => null);
      if (st) out.push({ userId: u.name, sessionId: s.name, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

// --- HTTP helpers ---
// JSON control bodies are tiny; cap them so a hostile/runaway request can't buffer
// unbounded memory. Uploads use the separate streaming MAX_UPLOAD gate, not this.
const MAX_BODY = 1024 * 1024; // 1 MB
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); } });
    req.on("error", reject);
  });
}
function jsonRes(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// --- HTTP API ---
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  if (method === "GET" && path === "/health") {
    // `allowNetwork` lets the platform's admin UI tell the truth about egress:
    // the in-app toggle only sets intent, but THIS deployment-level kill-switch
    // decides whether a bridge request actually gets network (see /sessions).
    return jsonRes(res, ready ? 200 : 503, { ok: true, ready, sessions: liveCount, allowNetwork: ALLOW_NETWORK });
  }

  // Boot-gate: 503 everything until reconcile finished.
  const gate = notReadyGuard({ ready, path });
  if (gate.block) return jsonRes(res, gate.status, { error: "Controller not ready" });

  if (!safeEqual(req.headers.authorization || "", `Bearer ${SECRET}`)) {
    return jsonRes(res, 401, { error: "Unauthorized" });
  }

  try {
    // POST /sessions — create (or reuse) sandbox
    if (method === "POST" && path === "/sessions") {
      const { sessionId, userId, networkMode, mounts: rawMounts } = await parseBody(req);
      if (!sessionId || !userId) return jsonRes(res, 400, { error: "Missing sessionId or userId" });
      const sid = sanitize(sessionId);
      const uid = sanitize(userId);
      // `_global` is the reserved per-user shared dir (see LocalFsStore#sharedPath);
      // GC skips it. A session by that id would collide with it and never be reaped.
      if (sid === "_global") return jsonRes(res, 400, { error: "Reserved sessionId" });

      // Validate + normalize the requested host folder mounts. Each name is
      // sanitized like a session id; each path runs through mount-safety with this
      // deployment's DATA_ROOT and optional allowlist. Invalid → 400 before any
      // container work.
      const reqMounts = [];
      if (Array.isArray(rawMounts)) {
        for (const m of rawMounts) {
          const name = sanitize(m?.name || "");
          if (!name) return jsonRes(res, 400, { error: "Invalid mount name", code: "invalid_mount" });
          const v = validateMountPath(m?.hostPath, { dataRoot: DATA_ROOT, hostDataRoot, allowRoots: MOUNT_ALLOW_ROOTS });
          if (!v.ok) return jsonRes(res, 400, { error: "Invalid mount path", code: "invalid_mount", reason: v.code });
          reqMounts.push({ hostPath: v.path, name, ro: m?.ro !== false });
        }
      }
      // Order-independent identity of a mount set, for drift detection.
      const mountKey = (m) => JSON.stringify([...m].sort((a, b) => a.name.localeCompare(b.name)));
      const reqKey = mountKey(reqMounts);

      const pre = await store.get(sid);
      if (pre && pre.userId !== uid) return jsonRes(res, 403, { error: "Session belongs to another user" });

      // Hot path — a live container is already up with the SAME mounts → reuse
      // without taking the lock. (Mid-op invalidation on the next exec handles a
      // container that vanished.) Different mounts fall through to the lock path,
      // which tears the container down and recreates it with the new set.
      if (pre && pre.handle && mountKey(pre.mounts || []) === reqKey) {
        await workspace.ensure(uid, sid);
        store.touch(sid);
        return jsonRes(res, 200, { sessionId: sid, status: "reused" });
      }

      // A fresh container is needed below — but on a first-boot box the sandbox
      // image may still be downloading in the background (see prewarm). Wait
      // briefly; if it's not ready, tell the caller we're still preparing rather
      // than letting their request time out on a multi-GB pull. Reuse of a live
      // container above never reaches here (its image is already present).
      if (backend.runtimeReady && !backend.runtimeReady()) {
        const imgReady = await backend.awaitRuntime(120_000);
        if (!imgReady) {
          return jsonRes(res, 503, {
            error: "Setting up the sandbox for first use (one-time download) — try again in a minute.",
            code: "IMAGE_PULLING",
          });
        }
      }

      // Slow path — spin a container (fresh workspace OR revive a stopped one).
      // Serialize per-session so two concurrent requests can't each create a
      // container (the loser would leak). Re-read inside the lock: another request
      // may have revived it while we waited.
      const out = await store.withSessionLock(sid, async () => {
        const existing = await store.get(sid);
        if (existing && existing.handle) {
          if (mountKey(existing.mounts || []) === reqKey) {
            await workspace.ensure(uid, sid);
            store.touch(sid);
            return { code: 200, body: { sessionId: sid, status: "reused" } };
          }
          // Mount set changed since the container came up → destroy and recreate
          // with the new mounts. Workspace files live on the host and survive;
          // running processes die (the confirm card warns about this).
          await backend.destroy(existing.handle).catch(() => {});
          await store.setStopped(sid);
          liveCount = Math.max(0, liveCount - 1);
          log("session.mounts.changed", { sessionId: sid, userId: uid });
        }

        // The per-user cap limits CONCURRENT LIVE containers (RAM), not stored
        // workspaces: evict the LRU live one by STOPPING it (its files stay).
        const victim = pickLruVictim(await store.listByUser(uid), MAX_SESSIONS_PER_USER, sid);
        if (victim) {
          await backend.destroy(victim.handle).catch(() => {});
          await store.setStopped(victim.sessionId);
          liveCount = Math.max(0, liveCount - 1);
          log("session.evict", { sessionId: victim.sessionId, userId: uid });
        }

        const { wsHostPath, sharedHostPath } = await workspace.ensure(uid, sid);
        // Honor the deployment kill-switch: a bridge request is downgraded to
        // "none" unless the operator opted the whole deployment into egress.
        const requestedNet = resolveNetworkMode(networkMode);
        const net = ALLOW_NETWORK ? requestedNet : "none";
        if (requestedNet === "bridge" && net === "none") {
          log("session.network.denied", { sessionId: sid, userId: uid, reason: "SANDBOX_ALLOW_NETWORK not set" });
        }
        const { handle } = await backend.create({
          sessionId: sid, userId: uid, wsHostPath, sharedHostPath,
          networkMode: net, memoryBytes: MEMORY_LIMIT, nanoCpus: CPU_LIMIT,
          pidsLimit: PIDS_LIMIT,
          tmpMb: TMP_MB, mcpTmpMb: MCP_TMP_MB,
          fsizeBytes: MAX_FILE_MB * 1024 * 1024,
          mounts: reqMounts,
        });
        const now = Date.now();
        await store.upsert({ sessionId: sid, userId: uid, handle, networkMode: net, mounts: reqMounts, lastActivity: now, createdAt: existing?.createdAt ?? now });
        liveCount++;
        log(existing ? "session.resume" : "session.create", { sessionId: sid, userId: uid, handle, image: SANDBOX_IMAGE });
        return { code: 201, body: { sessionId: sid, status: existing ? "resumed" : "created" } };
      });
      return jsonRes(res, out.code, out.body);
    }

    // POST /mounts/validate — dry-run a host folder path against mount-safety so
    // the platform can reject a bad path in the manage/settings UI before creating
    // a row. Single source of truth: the controller owns DATA_ROOT + allowlist.
    if (method === "POST" && path === "/mounts/validate") {
      const { hostPath } = await parseBody(req);
      const v = validateMountPath(hostPath, { dataRoot: DATA_ROOT, hostDataRoot, allowRoots: MOUNT_ALLOW_ROOTS });
      return jsonRes(res, 200, v.ok ? { ok: true } : { ok: false, code: v.code });
    }

    // POST /sessions/:id/exec
    const execMatch = path.match(/^\/sessions\/([^/]+)\/exec$/);
    if (method === "POST" && execMatch) {
      const session = await store.get(execMatch[1]);
      if (!session) return jsonRes(res, 404, { error: "Session not found" });
      // Stopped workspace (container reclaimed): tell the caller to recreate so a
      // fresh container is spun up against the same files. The platform's
      // ensureSession does exactly that before retrying.
      if (!session.handle) return jsonRes(res, 409, { error: "Sandbox is stopped; recreate the session" });
      // Disk-quota gate: refuse to run a command once the workspace is at/over the
      // cap, so a session that has filled /workspace can't keep growing it. The
      // escape is NOT `rm` (that's an exec and is blocked too — which would
      // deadlock cleanup); it's the ungated delete endpoint, surfaced to the agent
      // as the `delete_path` tool, which removes files AND folders. The message
      // names that so the agent recovers instead of looping on a blocked `rm`.
      if (await quota.isOverQuota(session.userId, session.sessionId)) {
        log("workspace.exec_blocked", { sessionId: session.sessionId, userId: session.userId, limitMb: MAX_WORKSPACE_MB }, "warn");
        return jsonRes(res, 413, {
          error: `Workspace is full (max ${MAX_WORKSPACE_MB}MB). Use the delete_path tool to remove large files or folders, then continue — running commands is paused until usage is back under the limit.`,
          code: "WORKSPACE_FULL",
        });
      }
      const { command, timeout } = await parseBody(req);
      if (!command) return jsonRes(res, 400, { error: "Missing command" });
      // Validate the caller timeout: a finite ms value, clamped to a sane band.
      // Garbage (NaN, negative, absurdly large) falls back to / is bounded by the
      // default so it can't disable the cap or pin a worker open indefinitely.
      const execTimeout = Number.isFinite(timeout)
        ? Math.min(Math.max(timeout, 1000), 300000)
        : EXEC_TIMEOUT;
      store.touch(session.sessionId);
      try {
        const result = await backend.exec(session.handle, command, execTimeout);
        return jsonRes(res, 200, result);
      } catch (e) {
        if (/no such container|is not running/i.test(e.message)) {
          // Mid-op invalidation: the container is gone (removed → "no such
          // container") OR present-but-stopped (its PID 1 exited → Docker 409
          // "container is not running", e.g. the entrypoint died at startup).
          // Both mean the handle is dead — drop the stale record so the platform's
          // ensureSession recreates a fresh container against the same files.
          await store.delete(session.sessionId);
          liveCount = Math.max(0, liveCount - 1);
          log("session.invalidate", { sessionId: session.sessionId }, "warn");
          return jsonRes(res, 409, { error: "Sandbox is gone; recreate the session" });
        }
        throw e;
      }
    }

    // POST /sessions/:id/mcp/:name/start — launch a stdio MCP server in the sandbox
    const mcpStartMatch = path.match(/^\/sessions\/([^/]+)\/mcp\/([^/]+)\/start$/);
    if (method === "POST" && mcpStartMatch) {
      const session = await store.get(mcpStartMatch[1]);
      if (!session) return jsonRes(res, 404, { error: "Session not found" });
      const { command, args, env } = await parseBody(req);
      if (!command || typeof command !== "string") return jsonRes(res, 400, { error: "Missing command" });
      store.touch(session.sessionId);
      try {
        await mcpBridge.start(session.handle, mcpStartMatch[2], { command, args, env });
        return jsonRes(res, 200, { ok: true });
      } catch (e) {
        console.error(`[mcp] start failed for ${mcpStartMatch[2]}:`, e.message);
        return jsonRes(res, 502, { error: "mcp start failed" });
      }
    }

    // POST /sessions/:id/mcp/:name/rpc — one JSON-RPC round-trip to that server
    const mcpRpcMatch = path.match(/^\/sessions\/([^/]+)\/mcp\/([^/]+)\/rpc$/);
    if (method === "POST" && mcpRpcMatch) {
      const session = await store.get(mcpRpcMatch[1]);
      if (!session) return jsonRes(res, 404, { error: "Session not found" });
      const { message } = await parseBody(req);
      store.touch(session.sessionId);
      try {
        const response = await mcpBridge.rpc(session.handle, mcpRpcMatch[2], message);
        return jsonRes(res, 200, { message: response });
      } catch (e) {
        console.error(`[mcp] rpc failed for ${mcpRpcMatch[2]}:`, e.message);
        return jsonRes(res, 502, { error: "mcp rpc failed" });
      }
    }

    // GET /sessions/:id/files
    const filesMatch = path.match(/^\/sessions\/([^/]+)\/files$/);
    if (method === "GET" && filesMatch) {
      const r = await resolveOwner(filesMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (r.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (r.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      store.touch(r.sessionId);
      // depth>1 lets the platform fetch a tree (workspace snapshot, folder-sync)
      // without a container; the file browser omits it and gets a single level.
      // Clamp 1..20 — folder sync needs the full nested tree, and the 1000-entry
      // limit in list() still bounds the response size.
      const depth = Math.min(20, Math.max(1, parseInt(url.searchParams.get("depth") || "1", 10) || 1));
      // Folder sync needs a COMPLETE tree: an incomplete listing looks like files
      // were deleted on the server and would drive a destructive local delete. It
      // asks for a high limit and checks `truncated` to abort if the tree is too
      // big to enumerate whole. Default 1000 keeps the file browser's cheap listing.
      const limit = Math.min(20000, Math.max(1, parseInt(url.searchParams.get("limit") || "1000", 10) || 1000));
      // hash=1 (folder sync) makes each file entry carry a content SHA-256 so the
      // bridge can detect a same-length edit; the file browser omits it (cheaper).
      const withHash = url.searchParams.get("hash") === "1";
      const { entries, truncated } = await workspace.list(r.userId, r.sessionId, url.searchParams.get("path") || ".", depth, limit, { withHash });
      return jsonRes(res, 200, { entries, truncated });
    }

    // DELETE /sessions/:id/files?path=  — remove one file (composer attachment
    // the user detached, or staged uploads being cleaned up).
    const fileDelMatch = path.match(/^\/sessions\/([^/]+)\/files$/);
    if (method === "DELETE" && fileDelMatch) {
      const r = await resolveOwner(fileDelMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (r.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (r.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      const filePath = url.searchParams.get("path");
      if (!filePath) return jsonRes(res, 400, { error: "Missing path" });
      store.touch(r.sessionId);
      try {
        await workspace.delete(r.userId, r.sessionId, filePath);
      } catch (e) {
        return jsonRes(res, 400, { error: e.message });
      }
      // Freeing space must lift the quota block immediately, not after the cache
      // TTL — otherwise an agent that just deleted junk is still refused its next
      // command for a few seconds. Drop the cached size so the next exec re-measures.
      quota.forget(r.sessionId);
      return jsonRes(res, 200, { ok: true });
    }

    // GET /sessions/:id/download
    const dlMatch = path.match(/^\/sessions\/([^/]+)\/download$/);
    if (method === "GET" && dlMatch) {
      const r = await resolveOwner(dlMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (r.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (r.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      const filePath = url.searchParams.get("path");
      if (!filePath) return jsonRes(res, 400, { error: "Missing path" });
      store.touch(r.sessionId);

      let stream;
      try {
        stream = await workspace.read(r.userId, r.sessionId, filePath);
      } catch {
        return jsonRes(res, 404, { error: "File not found" });
      }
      const rawName = filePath.split("/").pop() || "download";
      const safeName = rawName.replace(/[^\x20-\x7E]/g, "_");
      const encodedName = encodeURIComponent(rawName);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
      });
      stream.on("error", () => { if (!res.headersSent) jsonRes(res, 500, { error: "Read failed" }); else res.destroy(); });
      stream.pipe(res);
      return;
    }

    // GET /sessions/:id/archive — stream the WHOLE workspace as a gzipped tar,
    // owner-gated exactly like the file ops. Reads from the host directory root, so
    // it is complete regardless of any listing limit (unlike download-all). Powers
    // "download all files" and "download before deleting the project".
    const archiveMatch = path.match(/^\/sessions\/([^/]+)\/archive$/);
    if (method === "GET" && archiveMatch) {
      const r = await resolveOwner(archiveMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (r.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (r.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      store.touch(r.sessionId);
      const child = await workspace.archive(r.userId, r.sessionId);
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="workspace.tar.gz"`,
      });
      // streamArchive owns res.end()/destroy: a non-zero tar exit aborts the socket
      // instead of ending cleanly, so a truncated archive never reads as complete.
      streamArchive(child, res, log);
      return;
    }

    // POST /sessions/:id/copy-from — copy another workspace of the SAME user into
    // this one under a subdir (the chat→project file carry-over on a move). Both
    // source and destination are owner-gated by HMAC; idempotent by destination;
    // quota-gated on the target.
    const copyMatch = path.match(/^\/sessions\/([^/]+)\/copy-from$/);
    if (method === "POST" && copyMatch) {
      const destR = await resolveOwner(copyMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (destR.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (destR.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      const { srcSessionId, srcToken, subdir } = await parseBody(req);
      if (!srcSessionId || !subdir) return jsonRes(res, 400, { error: "Missing srcSessionId or subdir" });
      // The source must be owned by the SAME user — verify its own HMAC token so a
      // caller can't copy out of a workspace they don't own.
      const srcR = await resolveOwner(sanitize(srcSessionId), destR.userId, srcToken);
      if (srcR.forbidden || srcR.missing) return jsonRes(res, 403, { error: "Invalid or missing source token" });
      store.touch(destR.sessionId);
      try {
        const out = await workspace.copyInto(destR.userId, srcR.sessionId, destR.sessionId, subdir, {
          limitBytes: MAX_WORKSPACE_MB * 1024 * 1024,
        });
        quota.forget(destR.sessionId); // size grew — next exec must re-measure
        log("workspace.copy", { from: srcR.sessionId, to: destR.sessionId });
        return jsonRes(res, 200, { ok: true, subdir: out.subdir });
      } catch (e) {
        if (e.code === "WORKSPACE_FULL") {
          return jsonRes(res, 413, { error: `Workspace is full (max ${MAX_WORKSPACE_MB}MB).`, code: "WORKSPACE_FULL" });
        }
        return jsonRes(res, 400, { error: e.message });
      }
    }

    // POST /sessions/:id/upload (multipart)
    const upMatch = path.match(/^\/sessions\/([^/]+)\/upload$/);
    if (method === "POST" && upMatch) {
      const r = await resolveOwner(upMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (r.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (r.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      store.touch(r.sessionId);

      const contentType = req.headers["content-type"] || "";
      const chunks = [];
      let totalSize = 0;
      const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD) return jsonRes(res, 413, { error: `File too large (max ${MAX_UPLOAD_MB}MB)` });
        chunks.push(chunk);
      }
      const parsed = parseMultipart(Buffer.concat(chunks), contentType);
      if (!parsed) return jsonRes(res, 400, { error: "Missing multipart boundary" });

      const targetPath = (parsed.fields.path ?? "").trim() || ".";
      const file = parsed.files.find((f) => f.field === "file") ?? parsed.files[0];
      if (!file) return jsonRes(res, 400, { error: "No file in request" });
      const fileName = file.filename || "upload";

      const currentSize = await workspace.size(r.userId, r.sessionId);
      if (currentSize + file.data.length > MAX_WORKSPACE_MB * 1024 * 1024) {
        return jsonRes(res, 413, { error: `Workspace quota exceeded (max ${MAX_WORKSPACE_MB}MB)` });
      }
      const relPath = targetPath === "." ? fileName : `${targetPath}/${fileName}`;
      await workspace.write(r.userId, r.sessionId, relPath, file.data);
      return jsonRes(res, 200, { ok: true, path: relPath, name: fileName });
    }

    // DELETE /sessions/:id
    const deleteMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      // Teardown wipes the workspace, so it is owner-gated exactly like the file
      // ops: a valid HMAC token bound to userId+sessionId is required.
      const r = await resolveOwner(deleteMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (r.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (r.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      const s = await store.get(r.sessionId);
      // Explicit teardown: kill the container (if any) AND wipe the workspace. The
      // workspace wipe must run even with NO session row — a workspace can exist on
      // disk with no row (files uploaded before the first session was created, or
      // after an invalidation). Leaving `remove` under `if (s)` orphaned those dirs
      // forever, since the orphan GC only sweeps dirs with no row AFTER a grace
      // window and the project delete flow needs the files gone now.
      if (s) {
        if (s.handle != null) {
          mcpBridge.stopAll(s.handle);
          await backend.destroy(s.handle).catch(() => {});
          liveCount = Math.max(0, liveCount - 1);
        }
        await store.delete(s.sessionId);
      }
      await workspace.remove(r.userId, r.sessionId).catch(() => {});
      quota.forget(r.sessionId); // wipe → a recycled id must not read a stale size
      log("session.destroy", { sessionId: r.sessionId });
      return jsonRes(res, 200, { ok: true });
    }

    // GET /sessions — SECRET-GATED INTERNAL ADMIN LISTING ONLY. This returns every
    // user's sessions, so it is deliberately NOT a per-user endpoint: the bearer
    // secret check above is the only caller (the platform's own admin/GC tooling).
    // There is no userId-scoped variant — file ops use the per-session owner-gated
    // routes instead. Do not expose this to end-user-derived requests.
    if (method === "GET" && path === "/sessions") {
      const all = await store.all();
      return jsonRes(res, 200, all.map((s) => ({ id: s.sessionId, userId: s.userId, lastActivity: s.lastActivity })));
    }

    jsonRes(res, 404, { error: "Not found" });
  } catch (e) {
    // Log the detail server-side, but never echo it to the client: e.message can
    // carry host paths, container ids, or pg/mcp text. A tagged statusCode (e.g.
    // 413 from parseBody) is the only thing we surface, with a generic message.
    console.error(`[error] ${method} ${path}:`, e.message);
    if (!res.headersSent) {
      const status = e.statusCode || 500;
      jsonRes(res, status, { error: status === 413 ? "Request body too large" : "Internal error" });
    }
  }
});

// --- Idle cleanup ---
async function idleSweep() {
  try {
    await store.flush();
    const now = Date.now();
    for (const s of await store.all()) {
      if (s.handle == null) continue; // already stopped — no compute to reclaim
      if (now - s.lastActivity > IDLE_TTL) {
        // Reclaim the container, KEEP the workspace (files + row survive). The dir
        // is only deleted later by the TTL reaper if it stays unused for 30d.
        await backend.destroy(s.handle).catch(() => {});
        await store.setStopped(s.sessionId);
        liveCount = Math.max(0, liveCount - 1);
        log("session.idle", { sessionId: s.sessionId });
      }
    }
  } catch (e) {
    console.error("[idle] sweep failed:", e.message);
  }
}

// --- Periodic flush + workspace GC ---
async function flushAndGc() {
  try {
    await store.flush();
    // Disk hygiene: reap workspaces unused beyond the long TTL (row + dir), then
    // sweep any TRUE orphan dirs (no row at all) past the grace window.
    await reapStaleWorkspaces({ store, backend, workspace, ttlMs: WORKSPACE_TTL_MS, log });
    await gcOrphanWorkspaces({ store, workspace, listOnDisk: listWorkspacesOnDisk, graceMs: GC_GRACE_MS, log });
  } catch (e) {
    console.error("[gc] failed:", e.message);
  }
}

// Soft quota is advisory only — the sandbox can write to its bind mount past
// MAX_WORKSPACE_MB. Surface the breach for ops (host-level quota is the real
// enforcement). Runs on its own slow cadence and logs once per crossing, not on
// every sweep — the old code re-`du`'d every workspace each minute and re-logged
// the same breaches, which dominated the controller's idle CPU and the logs.
const overQuotaWarned = new Set();
async function overQuotaScan() {
  try {
    const limitBytes = MAX_WORKSPACE_MB * 1024 * 1024;
    // Reclaim regenerable deps from idle, stopped, over-quota workspaces first, so
    // the warning below fires only for genuinely-stuck ones (full of real files).
    if (typeof workspace.pruneRegenerable === "function") {
      await reclaimRegenerable({
        store, workspace, limitBytes, idleMs: REGEN_REAP_IDLE_MS,
        prune: async (u, s) => { await workspace.pruneRegenerable(u, s); quota.forget(s); },
        log,
      });
    }
    const over = await findOverQuota({ store, workspace, limitBytes, onSize: quota.note });
    for (const o of quotaWarnings(over, overQuotaWarned)) {
      log("workspace.over_quota", { ...o, mb: Math.round(o.bytes / 1048576), limitMb: MAX_WORKSPACE_MB }, "warn");
    }
  } catch (e) {
    console.error("[quota] scan failed:", e.message);
  }
}

// --- Boot ---
async function boot() {
  await store.init();
  hostDataRoot = await detectHostDataRoot(docker, {
    dataRoot: DATA_ROOT, hostname: hostname(), override: process.env.HOST_DATA_ROOT,
    // Remote daemon ⇒ binds need the real host path; refuse to boot on a wrong guess.
    failClosed: !!process.env.DOCKER_HOST,
  });
  workspace = makeWorkspaceStore({ kind: WORKSPACE_STORE, dataRoot: DATA_ROOT, hostDataRoot, uid: SANDBOX_UID, gid: SANDBOX_GID });
  backend = makeComputeBackend({ kind: COMPUTE_BACKEND, docker, image: SANDBOX_IMAGE, runtime: RUNTIME });

  // Fail-closed: if the secure profile was opted into, refuse to boot unless the
  // gVisor runtime is on the daemon. The standard profile (default) skips this.
  await assertRuntimeAvailable(docker, { profile: PROFILE, runtime: RUNTIME });

  // Make the weaker default posture loud rather than silent: a standard-profile
  // deploy runs untrusted code with ordinary Docker isolation only.
  if (PROFILE !== "secure") {
    log("isolation.unhardened", {
      profile: PROFILE, runtime: RUNTIME,
      hint: "Set SANDBOX_RUNTIME=runsc + install gVisor (scripts/install-gvisor.sh) for untrusted/multi-tenant workloads.",
    }, "warn");
  }

  // Serve early so the orchestrator can probe /health (503 elsewhere until ready).
  server.listen(PORT, () => log("listening", { port: PORT, profile: PROFILE, runtime: RUNTIME }));

  // Readiness depends only on reconcile — which needs the daemon but NOT the
  // sandbox image (it lists and tears down containers; it never creates one). So
  // report healthy as soon as reconcile succeeds and pull the sandbox image in
  // the BACKGROUND: a fresh box goes healthy in seconds instead of after a
  // multi-GB pull, and every orchestrator benefits (compose, Coolify), not just
  // the install scripts. A transient blip here shouldn't crash-loop the process:
  // retry with backoff while readiness stays false (so /health reports 503 and
  // the orchestrator holds traffic), giving up only after the budget.
  const summary = await withRetry(() => reconcile({ store, backend }),
    { attempts: 5, baseMs: 3000, label: "recover", log });
  liveCount = summary.kept.length;
  log("recover", summary);

  ready = true;
  log("ready", { profile: PROFILE });

  // A controller restart must not discard the in-memory activity cache. Stop
  // accepting traffic first, let current HTTP requests drain, persist activity,
  // then close Postgres and exit. Keeping the signal handlers installed makes
  // repeated orchestrator signals join the same idempotent shutdown sequence.
  const shutdown = createGracefulShutdown({
    server,
    store,
    pool,
    markNotReady: () => { ready = false; },
    stopMaintenance: () => {
      for (const timer of maintenanceTimers) clearInterval(timer);
      maintenanceTimers.clear();
    },
    log,
  });
  installShutdownHandlers(shutdown);

  // Best-effort image prewarm so the first session doesn't pay the pull. Never
  // gates readiness (create() answers 503 IMAGE_PULLING while this runs). A
  // transient failure — registry blip, momentary disk pressure — shouldn't leave
  // the image un-pulled until a user first hits it, so retry with backoff in the
  // background; if the budget is exhausted, log loudly and fall back on create()'s
  // own lazy ensureRuntime as the final self-heal.
  void withRetry(() => backend.ensureRuntime(), { attempts: 5, baseMs: 5000, label: "prewarm", log })
    .then(() => log("prewarm.done", {}))
    .catch((e) => log("prewarm.gaveup", { err: e.message, hint: "image not prefetched; first session pulls it on demand" }, "warn"));

  // Single-flight each periodic job: if a run is still going when the next tick
  // fires, skip it. flushAndGc and overQuotaScan do expensive du/tree walks over
  // every workspace, so under disk pressure a run can outlast its interval —
  // overlapping ticks would pile contending walks on top of each other. Also
  // catches a job's own throw so a bad tick can't crash the process.
  const periodic = (fn, everyMs, label) => {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return log("maintenance.skip", { job: label }, "warn");
      running = true;
      try { await fn(); }
      catch (e) { log("maintenance.error", { job: label, err: e.message }, "warn"); }
      finally { running = false; }
    }, everyMs);
    maintenanceTimers.add(timer);
  };
  periodic(idleSweep, 60_000, "idleSweep");
  periodic(flushAndGc, FLUSH_INTERVAL_MS, "flushAndGc");
  void overQuotaScan(); // one breach report on boot, then on the slow cadence
  periodic(overQuotaScan, OVER_QUOTA_SCAN_MS, "overQuotaScan");
}

// Test seam: with CONTROLLER_NO_BOOT set, skip the Docker-dependent boot so the
// HTTP app can be exercised over real sockets against a throwaway Postgres + a
// fake backend (see server.http.test.js). Inert in production. `store` is the
// real PostgresSessionStore bound to DATABASE_URL.
export { server, store };
export function __setTestState(s = {}) {
  if (s.workspace !== undefined) workspace = s.workspace;
  if (s.backend !== undefined) backend = s.backend;
  if (s.ready !== undefined) ready = s.ready;
  if (s.liveCount !== undefined) liveCount = s.liveCount;
}

if (!process.env.CONTROLLER_NO_BOOT) {
  boot().catch((e) => {
    console.error("[boot] FATAL:", e.message);
    process.exit(1);
  });
}
