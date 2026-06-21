import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import Docker from "dockerode";
import pg from "pg";
import { sanitize } from "./path-safety.js";
import { parseMultipart } from "./multipart.js";
import { resolveNetworkMode } from "./sandbox-spec.js";
import { makeComputeBackend } from "./backends/backend-factory.js";
import { makeWorkspaceStore } from "./stores/workspace-factory.js";
import { detectHostDataRoot } from "./stores/local-fs-store.js";
import { PostgresSessionStore } from "./session-store.js";
import { assertRuntimeAvailable } from "./runtime-check.js";
import { reconcile } from "./reconcile.js";
import { gcOrphanWorkspaces } from "./gc.js";
import { notReadyGuard } from "./readiness.js";
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
const ALLOW_NETWORK = process.env.SANDBOX_ALLOW_NETWORK === "true";
const MEMORY_LIMIT = parseInt(process.env.SANDBOX_MEMORY_MB || "512") * 1024 * 1024;
const CPU_LIMIT = parseFloat(process.env.SANDBOX_CPUS || "1.0") * 1e9;
const EXEC_TIMEOUT = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || "30000");
const IDLE_TTL = parseInt(process.env.SANDBOX_IDLE_TTL_MS || "900000"); // 15 min
const DATA_ROOT = process.env.DATA_ROOT || "/data/storage";
const MAX_SESSIONS_PER_USER = parseInt(process.env.MAX_SESSIONS_PER_USER || "5");
const MAX_WORKSPACE_MB = parseInt(process.env.MAX_WORKSPACE_MB || "500");
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "100");
const SANDBOX_UID = parseInt(process.env.SANDBOX_UID || "1000");
const SANDBOX_GID = parseInt(process.env.SANDBOX_GID || "1000");
const GC_GRACE_MS = parseInt(process.env.GC_GRACE_MS || "3600000"); // 1h
const FLUSH_INTERVAL_MS = parseInt(process.env.FLUSH_INTERVAL_MS || "60000");

// Isolation profile: "secure" (gVisor, fail-closed) default; "dev" allows runc.
const RUNTIME = process.env.SANDBOX_RUNTIME || "runsc";
const PROFILE = process.env.SANDBOX_PROFILE || (RUNTIME === "runc" ? "dev" : "secure");
const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND || "docker";
const WORKSPACE_STORE = process.env.WORKSPACE_STORE || "local";
const DATABASE_URL = process.env.DATABASE_URL;

// --- Wiring (set during boot) ---
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const store = new PostgresSessionStore({ pool });
let workspace;
let backend;
let ready = false;
let liveCount = 0;

// --- Auth ---
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Sign a userId+sessionId pair so file ops can trust a workspace owner even with
 *  no running container; the platform derives the same HMAC from the shared secret. */
function workspaceToken(userId, sessionId) {
  return createHmac("sha256", SECRET)
    .update(`${sanitize(userId)}|${sanitize(sessionId)}`)
    .digest("hex");
}

/** Resolve the owner of a file op: a live session's owner, else a platform-supplied
 *  userId backed by a valid HMAC token. Returns { userId, sessionId } | { missing } | { forbidden }. */
async function resolveOwner(sessionId, fallbackUserId, token) {
  const s = await store.get(sessionId);
  if (s) return { userId: s.userId, sessionId };
  if (!fallbackUserId) return { missing: true };
  if (!token || !safeEqual(workspaceToken(fallbackUserId, sessionId), token)) return { forbidden: true };
  return { userId: sanitize(fallbackUserId), sessionId: sanitize(sessionId) };
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
    return jsonRes(res, ready ? 200 : 503, { ok: true, ready, sessions: liveCount });
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

      const existing = await store.get(sid);
      if (existing) {
        if (existing.userId !== uid) return jsonRes(res, 403, { error: "Session belongs to another user" });
        // Assume live; mid-op invalidation handles a vanished container on next exec.
        await workspace.ensure(uid, sid);
        store.touch(sid);
        return jsonRes(res, 200, { sessionId: sid, status: "reused" });
      }

      // Per-user limit — evict least-recently-used idle session.
      const userSessions = await store.listByUser(uid);
      if (userSessions.length >= MAX_SESSIONS_PER_USER) {
        const victim = userSessions.reduce((min, cur) => (cur.lastActivity < min.lastActivity ? cur : min));
        await backend.destroy(victim.handle);
        await store.delete(victim.sessionId);
        liveCount = Math.max(0, liveCount - 1);
        log("session.evict", { sessionId: victim.sessionId, userId: uid });
      }

      const { wsHostPath, sharedHostPath } = await workspace.ensure(uid, sid);
      const net = resolveNetworkMode(networkMode, { allowNetwork: ALLOW_NETWORK });
      const { handle } = await backend.create({
        sessionId: sid, userId: uid, wsHostPath, sharedHostPath,
        networkMode: net, memoryBytes: MEMORY_LIMIT, nanoCpus: CPU_LIMIT,
      });
      const now = Date.now();
      await store.upsert({ sessionId: sid, userId: uid, handle, networkMode: net, lastActivity: now, createdAt: now });
      liveCount++;
      log("session.create", { sessionId: sid, userId: uid, handle, image: SANDBOX_IMAGE });
      return jsonRes(res, 201, { sessionId: sid, status: "created" });
    }

    // POST /sessions/:id/exec
    const execMatch = path.match(/^\/sessions\/([^/]+)\/exec$/);
    if (method === "POST" && execMatch) {
      const session = await store.get(execMatch[1]);
      if (!session) return jsonRes(res, 404, { error: "Session not found" });
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

    // GET /sessions/:id/files
    const filesMatch = path.match(/^\/sessions\/([^/]+)\/files$/);
    if (method === "GET" && filesMatch) {
      const r = await resolveOwner(filesMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (r.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (r.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      store.touch(r.sessionId);
      const entries = await workspace.list(r.userId, r.sessionId, url.searchParams.get("path") || ".");
      return jsonRes(res, 200, { entries });
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
        await backend.destroy(s.handle);
        await store.delete(s.sessionId);
        liveCount = Math.max(0, liveCount - 1);
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
      if (now - s.lastActivity > IDLE_TTL) {
        await backend.destroy(s.handle);
        await store.delete(s.sessionId);
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
    await gcOrphanWorkspaces({ store, workspace, listOnDisk: listWorkspacesOnDisk, graceMs: GC_GRACE_MS, log });
  } catch (e) {
    console.error("[gc] failed:", e.message);
  }
}

// --- Boot ---
async function boot() {
  await store.init();
  const hostDataRoot = await detectHostDataRoot(docker, {
    dataRoot: DATA_ROOT, hostname: hostname(), override: process.env.HOST_DATA_ROOT,
  });
  workspace = makeWorkspaceStore({ kind: WORKSPACE_STORE, dataRoot: DATA_ROOT, hostDataRoot, uid: SANDBOX_UID, gid: SANDBOX_GID });
  backend = makeComputeBackend({ kind: COMPUTE_BACKEND, docker, image: SANDBOX_IMAGE, runtime: RUNTIME });

  // Fail-closed: refuse to boot if the secure runtime isn't on the daemon.
  await assertRuntimeAvailable(docker, { profile: PROFILE, runtime: RUNTIME });

  // Serve early so the orchestrator can probe /health (503 elsewhere until ready).
  server.listen(PORT, () => log("listening", { port: PORT, profile: PROFILE, runtime: RUNTIME }));

  await backend.ensureRuntime(); // boot prewarm — first user doesn't pay the pull
  const summary = await reconcile({ store, backend });
  liveCount = summary.kept.length;
  log("recover", summary);

  ready = true;
  log("ready", { profile: PROFILE });

  setInterval(idleSweep, 60_000);
  setInterval(flushAndGc, FLUSH_INTERVAL_MS);
}

boot().catch((e) => {
  console.error("[boot] FATAL:", e.message);
  process.exit(1);
});
