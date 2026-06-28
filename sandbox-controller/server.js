import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import Docker from "dockerode";
import pg from "pg";
import { sanitize } from "./path-safety.js";
import { resolveOwnerDecision, safeEqual } from "./owner.js";
import { parseMultipart } from "./multipart.js";
import { resolveNetworkMode } from "./sandbox-spec.js";
import { makeComputeBackend } from "./backends/backend-factory.js";
import { makeWorkspaceStore } from "./stores/workspace-factory.js";
import { detectHostDataRoot } from "./stores/local-fs-store.js";
import { PostgresSessionStore } from "./session-store.js";
import { assertRuntimeAvailable } from "./runtime-check.js";
import { resolveRuntimeProfile } from "./profile.js";
import { reconcile } from "./reconcile.js";
import { gcOrphanWorkspaces, findOverQuota, reapStaleWorkspaces } from "./gc.js";
import { createQuotaTracker } from "./workspace-quota.js";
import { pickLruVictim } from "./session-policy.js";
import { notReadyGuard } from "./readiness.js";
import { withRetry } from "./retry.js";
import { createMcpBridge } from "./mcp-bridge.js";
import { log } from "./log.js";

// --- Talk to the Docker API via DOCKER_HOST (socket-proxy) when set. ---
const docker = process.env.DOCKER_HOST
  ? new Docker()
  : new Docker({ socketPath: "/var/run/docker.sock" });

const PORT = process.env.PORT || 3001;
const SECRET = process.env.CONTROLLER_SECRET;

// Root-equivalent service: refuse to boot without a strong secret.
const DEFAULT_SECRET = "unclaw-sandbox-secret";
if (!SECRET || (SECRET === DEFAULT_SECRET && process.env.ALLOW_DEFAULT_SECRET !== "true")) {
  console.error(
    "[sandbox-controller] FATAL: CONTROLLER_SECRET is unset or left at the default value.\n" +
    "  Generate a strong secret and set it on both controller and platform: openssl rand -hex 32",
  );
  process.exit(1);
}

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "unclaw-sandbox";
const TMP_MB = parseInt(process.env.SANDBOX_TMP_MB || "64");
const MCP_TMP_MB = parseInt(process.env.SANDBOX_MCP_TMP_MB || "256");
const MEMORY_LIMIT = parseInt(process.env.SANDBOX_MEMORY_MB || "512") * 1024 * 1024;
const CPU_LIMIT = parseFloat(process.env.SANDBOX_CPUS || "1.0") * 1e9;
const EXEC_TIMEOUT = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || "30000");
const IDLE_TTL = parseInt(process.env.SANDBOX_IDLE_TTL_MS || "900000"); // 15 min — stop idle CONTAINER (files stay)
const WORKSPACE_TTL_MS = parseInt(process.env.WORKSPACE_TTL_MS || "2592000000"); // 30d — delete a workspace (row + disk) unused this long
const DATA_ROOT = process.env.DATA_ROOT || "/data/storage";
const MAX_SESSIONS_PER_USER = parseInt(process.env.MAX_SESSIONS_PER_USER || "5");
const MAX_WORKSPACE_MB = parseInt(process.env.MAX_WORKSPACE_MB || "500");
// Hard per-file size cap (RLIMIT_FSIZE), kernel-enforced. Defaults to the whole
// workspace budget: no single file may exceed the total quota anyway, and this
// stops a one-command disk bomb (`fallocate -l 100G`) that the poll-based quota
// can't catch until the NEXT exec. Set MAX_FILE_MB=0 to disable.
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || String(MAX_WORKSPACE_MB));
// How long a measured workspace size is trusted before re-walking the tree. Keeps
// the expensive du off the hot exec path and coalesces command bursts.
const QUOTA_CACHE_TTL_MS = parseInt(process.env.QUOTA_CACHE_TTL_MS || "5000");
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "100");
const SANDBOX_UID = parseInt(process.env.SANDBOX_UID || "1000");
const SANDBOX_GID = parseInt(process.env.SANDBOX_GID || "1000");
const GC_GRACE_MS = parseInt(process.env.GC_GRACE_MS || "3600000"); // 1h
const FLUSH_INTERVAL_MS = parseInt(process.env.FLUSH_INTERVAL_MS || "60000");
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
const MCP_UID = parseInt(process.env.SANDBOX_MCP_UID || "1001");
const MCP_GID = parseInt(process.env.SANDBOX_MCP_GID || "1001");
const mcpBridge = createMcpBridge(docker, { user: `${MCP_UID}:${MCP_GID}` });
let workspace;
let backend;
let ready = false;
let liveCount = 0;

// App-level disk-quota guard. The `size` closure reads the module-level
// `workspace` lazily, so it picks up the real store after boot (and the fake one
// injected by tests via __setTestState). See workspace-quota.js for the why.
const quota = createQuotaTracker({
  size: (userId, sessionId) => workspace.size(userId, sessionId),
  limitBytes: MAX_WORKSPACE_MB * 1024 * 1024,
  ttlMs: QUOTA_CACHE_TTL_MS,
});

/** Resolve the owner of a file op: a live session's owner (cross-checked against
 *  any supplied userId), else a platform-supplied userId backed by a valid HMAC
 *  token. Decision logic is pure + unit-tested in owner.js. */
async function resolveOwner(sessionId, fallbackUserId, token) {
  const session = await store.get(sessionId);
  return resolveOwnerDecision({ session, sessionId, fallbackUserId, token, secret: SECRET });
}

// --- On-disk workspace listing (for GC). Skips the per-user _global shared dir. ---
async function listWorkspacesOnDisk() {
  const out = [];
  const users = await readdir(DATA_ROOT, { withFileTypes: true }).catch(() => []);
  for (const u of users) {
    if (!u.isDirectory()) continue;
    const sessions = await readdir(join(DATA_ROOT, u.name), { withFileTypes: true }).catch(() => []);
    for (const s of sessions) {
      if (!s.isDirectory() || s.name === "_global") continue;
      const st = await stat(join(DATA_ROOT, u.name, s.name)).catch(() => null);
      if (st) out.push({ userId: u.name, sessionId: s.name, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

// --- HTTP helpers ---
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
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
      const { sessionId, userId, networkMode } = await parseBody(req);
      if (!sessionId || !userId) return jsonRes(res, 400, { error: "Missing sessionId or userId" });
      const sid = sanitize(sessionId);
      const uid = sanitize(userId);

      const pre = await store.get(sid);
      if (pre && pre.userId !== uid) return jsonRes(res, 403, { error: "Session belongs to another user" });

      // Hot path — a live container is already up → reuse without taking the lock.
      // (Mid-op invalidation on the next exec handles a container that vanished.)
      if (pre && pre.handle) {
        await workspace.ensure(uid, sid);
        store.touch(sid);
        return jsonRes(res, 200, { sessionId: sid, status: "reused" });
      }

      // Slow path — spin a container (fresh workspace OR revive a stopped one).
      // Serialize per-session so two concurrent requests can't each create a
      // container (the loser would leak). Re-read inside the lock: another request
      // may have revived it while we waited.
      const out = await store.withSessionLock(sid, async () => {
        const existing = await store.get(sid);
        if (existing && existing.handle) {
          await workspace.ensure(uid, sid);
          store.touch(sid);
          return { code: 200, body: { sessionId: sid, status: "reused" } };
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
          tmpMb: TMP_MB, mcpTmpMb: MCP_TMP_MB,
          fsizeBytes: MAX_FILE_MB * 1024 * 1024,
        });
        const now = Date.now();
        await store.upsert({ sessionId: sid, userId: uid, handle, networkMode: net, lastActivity: now, createdAt: existing?.createdAt ?? now });
        liveCount++;
        log(existing ? "session.resume" : "session.create", { sessionId: sid, userId: uid, handle, image: SANDBOX_IMAGE });
        return { code: 201, body: { sessionId: sid, status: existing ? "resumed" : "created" } };
      });
      return jsonRes(res, out.code, out.body);
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
      store.touch(session.sessionId);
      try {
        const result = await backend.exec(session.handle, command, timeout || EXEC_TIMEOUT);
        return jsonRes(res, 200, result);
      } catch (e) {
        if (/no such container/i.test(e.message)) {
          // Mid-op invalidation: container died (e.g. OOM) — drop the stale record.
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
        return jsonRes(res, 502, { error: `mcp start failed: ${e.message}` });
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
        return jsonRes(res, 502, { error: `mcp rpc failed: ${e.message}` });
      }
    }

    // GET /sessions/:id/files
    const filesMatch = path.match(/^\/sessions\/([^/]+)\/files$/);
    if (method === "GET" && filesMatch) {
      const r = await resolveOwner(filesMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (r.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (r.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      store.touch(r.sessionId);
      // depth>1 lets the platform fetch a shallow tree (workspace snapshot) without
      // a container; the file browser omits it and gets a single level. Clamp 1..5.
      const depth = Math.min(5, Math.max(1, parseInt(url.searchParams.get("depth") || "1", 10) || 1));
      const entries = await workspace.list(r.userId, r.sessionId, url.searchParams.get("path") || ".", depth);
      return jsonRes(res, 200, { entries });
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
      const s = await store.get(deleteMatch[1]);
      if (s) {
        // Explicit teardown: kill the container (if any) AND wipe the workspace.
        if (s.handle != null) {
          mcpBridge.stopAll(s.handle);
          await backend.destroy(s.handle).catch(() => {});
          liveCount = Math.max(0, liveCount - 1);
        }
        await store.delete(s.sessionId);
        await workspace.remove(s.userId, s.sessionId).catch(() => {});
        quota.forget(s.sessionId); // wipe → a recycled id must not read a stale size
        log("session.destroy", { sessionId: s.sessionId });
      }
      return jsonRes(res, 200, { ok: true });
    }

    // GET /sessions
    if (method === "GET" && path === "/sessions") {
      const all = await store.all();
      return jsonRes(res, 200, all.map((s) => ({ id: s.sessionId, userId: s.userId, lastActivity: s.lastActivity })));
    }

    jsonRes(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(`[error] ${method} ${path}:`, e.message);
    if (!res.headersSent) jsonRes(res, 500, { error: e.message });
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
    // Soft quota is advisory only — the sandbox can write to its bind mount past
    // MAX_WORKSPACE_MB. Surface the breach for ops; real enforcement is host-level.
    for (const o of await findOverQuota({ store, workspace, limitBytes: MAX_WORKSPACE_MB * 1024 * 1024, onSize: quota.note })) {
      log("workspace.over_quota", { ...o, mb: Math.round(o.bytes / 1048576), limitMb: MAX_WORKSPACE_MB }, "warn");
    }
  } catch (e) {
    console.error("[gc] failed:", e.message);
  }
}

// --- Boot ---
async function boot() {
  await store.init();
  const hostDataRoot = await detectHostDataRoot(docker, {
    dataRoot: DATA_ROOT, hostname: hostname(), override: process.env.HOST_DATA_ROOT,
    // Remote daemon ⇒ binds need the real host path; refuse to boot on a wrong guess.
    failClosed: !!process.env.DOCKER_HOST,
  });
  workspace = makeWorkspaceStore({ kind: WORKSPACE_STORE, dataRoot: DATA_ROOT, hostDataRoot, uid: SANDBOX_UID, gid: SANDBOX_GID });
  backend = makeComputeBackend({ kind: COMPUTE_BACKEND, docker, image: SANDBOX_IMAGE, runtime: RUNTIME });

  // Fail-closed: if the secure profile was opted into, refuse to boot unless the
  // gVisor runtime is on the daemon. The dev profile (default) skips this.
  await assertRuntimeAvailable(docker, { profile: PROFILE, runtime: RUNTIME });

  // Make the weaker default posture loud rather than silent: a dev-profile deploy
  // runs untrusted code with standard Docker isolation only.
  if (PROFILE !== "secure") {
    log("isolation.unhardened", {
      profile: PROFILE, runtime: RUNTIME,
      hint: "Set SANDBOX_RUNTIME=runsc + install gVisor (scripts/install-gvisor.sh) for untrusted/multi-tenant workloads.",
    }, "warn");
  }

  // Serve early so the orchestrator can probe /health (503 elsewhere until ready).
  server.listen(PORT, () => log("listening", { port: PORT, profile: PROFILE, runtime: RUNTIME }));

  // Recovery (image prewarm + reconcile) needs the daemon. A transient blip here
  // shouldn't crash-loop the process: retry with backoff while readiness stays
  // false (so /health reports 503 and the orchestrator holds traffic), and only
  // give up — exit, letting the restart policy take over — after the budget.
  const summary = await withRetry(async () => {
    await backend.ensureRuntime(); // first user doesn't pay the image pull
    return reconcile({ store, backend });
  }, { attempts: 5, baseMs: 3000, label: "recover", log });
  liveCount = summary.kept.length;
  log("recover", summary);

  ready = true;
  log("ready", { profile: PROFILE });

  setInterval(idleSweep, 60_000);
  setInterval(flushAndGc, FLUSH_INTERVAL_MS);
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
