import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat, mkdir, chown } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, resolve, basename } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import Docker from "dockerode";
import { sanitize, safeJoin, safeRealPath } from "./path-safety.js";
import { parseMultipart } from "./multipart.js";
import { buildSandboxConfig, resolveNetworkMode } from "./sandbox-spec.js";

// Talk to the Docker API via DOCKER_HOST when set (in compose this points at the
// docker-socket-proxy, which exposes only the endpoints we need — the host
// socket is never mounted into this container). Falls back to the raw host
// socket for bare/dev runs.
const docker = process.env.DOCKER_HOST
  ? new Docker()
  : new Docker({ socketPath: "/var/run/docker.sock" });
const PORT = process.env.PORT || 3001;
const SECRET = process.env.CONTROLLER_SECRET;

// This controller has unrestricted access to the Docker socket — anyone who can
// authenticate to it is root-equivalent on the host. Refuse to boot without a
// strong secret. ALLOW_DEFAULT_SECRET is a local-dev-only escape hatch.
const DEFAULT_SECRET = "unclaw-sandbox-secret";
if (!SECRET || (SECRET === DEFAULT_SECRET && process.env.ALLOW_DEFAULT_SECRET !== "true")) {
  console.error(
    "[sandbox-controller] FATAL: CONTROLLER_SECRET is unset or left at the default value.\n" +
    "  This service can control the Docker daemon (root-equivalent on the host).\n" +
    "  Generate a strong secret and set CONTROLLER_SECRET on both the controller\n" +
    "  and the platform:  openssl rand -hex 32\n" +
    "  (Local development only: set ALLOW_DEFAULT_SECRET=true to bypass this check.)",
  );
  process.exit(1);
}

/** Constant-time string comparison (avoids timing oracles on the shared secret). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "unclaw-sandbox";
// Sandbox networking is off by default; the operator opts in per deployment.
const ALLOW_NETWORK = process.env.SANDBOX_ALLOW_NETWORK === "true";
const MEMORY_LIMIT = parseInt(process.env.SANDBOX_MEMORY_MB || "512") * 1024 * 1024;
const CPU_LIMIT = parseFloat(process.env.SANDBOX_CPUS || "1.0") * 1e9;
const EXEC_TIMEOUT = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || "30000");
const IDLE_TTL = parseInt(process.env.SANDBOX_IDLE_TTL_MS || "900000"); // 15 min
const DATA_ROOT = process.env.DATA_ROOT || resolve(import.meta.dirname, "..", "data", "storage");
// The controller reads/writes workspaces via DATA_ROOT (its own filesystem), but
// when it asks Docker to bind-mount a workspace into a SIBLING sandbox container,
// Docker resolves the bind source on the DAEMON host — not inside this container.
// So sandbox binds must use the host path. On native Linux the controller usually
// mounts the host dir at the same path, so HOST_DATA_ROOT defaults to DATA_ROOT
// (identity); on Docker Desktop it must be set to the real host path of the mount.
const HOST_DATA_ROOT = process.env.HOST_DATA_ROOT || DATA_ROOT;
/** Translate a controller-internal storage path to the daemon-host path used for binds. */
function toHostPath(internalPath) {
  return internalPath.startsWith(DATA_ROOT)
    ? HOST_DATA_ROOT + internalPath.slice(DATA_ROOT.length)
    : internalPath;
}
const MAX_SESSIONS_PER_USER = parseInt(process.env.MAX_SESSIONS_PER_USER || "5");
const MAX_WORKSPACE_MB = parseInt(process.env.MAX_WORKSPACE_MB || "500");
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "100");
// Must match the uid/gid the sandbox image runs as (User 1000:1000 below).
const SANDBOX_UID = parseInt(process.env.SANDBOX_UID || "1000");
const SANDBOX_GID = parseInt(process.env.SANDBOX_GID || "1000");

// Active sessions: sessionId -> { containerId, userId, lastActivity }
const sessions = new Map();

/** Resolve workspace path on host, with traversal protection */
function workspacePath(userId, sessionId) {
  return resolve(DATA_ROOT, sanitize(userId), sanitize(sessionId), "sandbox");
}

/** Per-user global folder, mounted as /shared into every container.
 *  "_global" can never collide with a nanoid session id. */
function globalPath(userId) {
  return resolve(DATA_ROOT, sanitize(userId), "_global", "sandbox");
}

/** Create + own the workspace and shared mount points for a session.
 *  The controller runs as root and creates dirs root-owned, but the sandbox
 *  container runs as a non-root user — chown the mounts so the agent can write
 *  to /workspace and /shared. Idempotent: also repairs pre-existing folders.
 *  (CapAdd DAC_OVERRIDE is not reliably effective for the non-root user, so we
 *  fix ownership rather than rely on it.) Returns the workspace path. */
async function ensureMounts(userId, sessionId) {
  const wsPath = workspacePath(userId, sessionId);
  const sharedPath = globalPath(userId);
  await mkdir(wsPath, { recursive: true });
  await mkdir(sharedPath, { recursive: true });
  // On native Linux the controller creates these root-owned, so chown them to the
  // sandbox user. On Docker Desktop the host-path bind already maps to the
  // container user, and chown is a virtiofs no-op — harmless either way.
  for (const dir of [wsPath, sharedPath]) {
    await chown(dir, SANDBOX_UID, SANDBOX_GID).catch(() => {});
  }
  return wsPath;
}

/** Sign a userId+sessionId pair so the controller can trust a workspace owner
 *  even when no container is running. The platform (which authenticated the user
 *  and verified ownership) derives the same HMAC from the shared secret. Without
 *  this, anyone holding the bearer secret could read/write ANY user's workspace
 *  by passing an arbitrary userId in the query string. */
function workspaceToken(userId, sessionId) {
  return createHmac("sha256", SECRET)
    .update(`${sanitize(userId)}|${sanitize(sessionId)}`)
    .digest("hex");
}

/** Resolve the host workspace base for a file op. Prefers the live session's
 *  owner; otherwise trusts a platform-supplied userId ONLY if accompanied by a
 *  valid HMAC token (so file management works without a running container while
 *  still binding the request to one user). Returns:
 *    { wsBase, session } on success,
 *    { missing: true }   when no owner could be determined,
 *    { forbidden: true } when the token is absent or invalid. */
function resolveWsBase(sessionId, fallbackUserId, token) {
  const session = sessions.get(sessionId);
  if (session) return { wsBase: workspacePath(session.userId, sessionId), session };
  if (!fallbackUserId) return { missing: true };
  if (!token || !safeEqual(workspaceToken(fallbackUserId, sessionId), token)) {
    return { forbidden: true };
  }
  return { wsBase: workspacePath(sanitize(fallbackUserId), sessionId), session: null };
}

/** Calculate directory size recursively */
async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += await dirSize(full);
      else total += (await stat(full)).size;
    }
  } catch { /* dir doesn't exist yet */ }
  return total;
}

// --- Docker helpers ---

async function createSandbox(sessionId, userId, networkMode = "none") {
  sessionId = sanitize(sessionId);
  userId = sanitize(userId);
  networkMode = resolveNetworkMode(networkMode, { allowNetwork: ALLOW_NETWORK });
  const wsPath = await ensureMounts(userId, sessionId);
  const sharedPath = globalPath(userId);

  const container = await docker.createContainer(
    buildSandboxConfig({
      image: SANDBOX_IMAGE,
      sessionId,
      userId,
      wsHostPath: toHostPath(wsPath),
      sharedHostPath: toHostPath(sharedPath),
      networkMode,
      memoryBytes: MEMORY_LIMIT,
      nanoCpus: CPU_LIMIT,
    }),
  );

  await container.start();

  const session = { containerId: container.id, userId, networkMode, lastActivity: Date.now() };
  sessions.set(sessionId, session);
  return session;
}

/** Restart a stopped container (e.g. after idle cleanup) */
async function restartSandbox(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  try {
    const container = docker.getContainer(session.containerId);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return session;
  } catch {
    // Container gone — remove stale session
    sessions.delete(sessionId);
    return null;
  }
}

async function execInSandbox(containerId, command, timeout = EXEC_TIMEOUT) {
  const container = docker.getContainer(containerId);

  // Run the user command inside its OWN session (setsid → it becomes a process
  // group leader, so PGID == PID in the CONTAINER's pid namespace). On timeout, an
  // in-container watcher SIGKILLs the whole group (`kill -KILL -$pid`), so forked
  // children (`foo &`, nohup, subshells) die too. The previous approach killed
  // `info.Pid` — a HOST pid — from inside the container, which targets the wrong
  // namespace and leaked background children that held the slot until idle-TTL.
  // base64 keeps the user command verbatim regardless of quoting.
  const secs = Math.max(1, Math.ceil(timeout / 1000));
  const b64 = Buffer.from(command).toString("base64");
  const wrapper =
    `__cmd=$(echo ${b64} | base64 -d); ` +
    `setsid bash -c "$__cmd" & __pid=$!; ` +
    `( sleep ${secs}; kill -KILL -"$__pid" 2>/dev/null ) & __killer=$!; ` +
    `wait "$__pid"; __rc=$?; ` +
    `kill "$__killer" 2>/dev/null; wait "$__killer" 2>/dev/null; ` +
    `exit $__rc`;

  const execObj = await container.exec({
    Cmd: ["bash", "-c", wrapper],
    AttachStdout: true,
    AttachStderr: true,
    User: "1000:1000",
    WorkingDir: "/workspace",
  });

  return new Promise((resolve, reject) => {
    // Backstop only: the in-container watcher self-kills at `secs`. If even that
    // wedges (e.g. an uninterruptible syscall), reject after a grace period so
    // the controller never hangs on the stream forever.
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout + 5000);

    execObj.start({ hijack: true }, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }

      let stdout = "";
      let stderr = "";

      stream.on("data", (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) break;
          const type = chunk[offset];
          const size = chunk.readUInt32BE(offset + 4);
          offset += 8;
          if (offset + size > chunk.length) break;
          const text = chunk.slice(offset, offset + size).toString("utf8");
          if (type === 1) stdout += text;
          else if (type === 2) stderr += text;
          offset += size;
        }
      });

      stream.on("end", async () => {
        clearTimeout(timer);
        try {
          const info = await execObj.inspect();
          resolve({ stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 50_000), exitCode: info.ExitCode });
        } catch {
          resolve({ stdout, stderr, exitCode: -1 });
        }
      });

      stream.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  });
}

async function destroySandbox(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    const container = docker.getContainer(session.containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch { /* already gone */ }
  sessions.delete(sessionId);
}

// --- Idle cleanup ---

setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > IDLE_TTL) {
      console.log(`[cleanup] destroying idle sandbox ${id}`);
      await destroySandbox(id);
    }
  }
}, 60_000);

// --- Recover existing sandboxes on startup ---

async function recoverSessions() {
  try {
    const containers = await docker.listContainers({ all: true, filters: { label: ["unclaw.session"] } });
    for (const c of containers) {
      const sessionId = c.Labels["unclaw.session"];
      const userId = c.Labels["unclaw.user"];
      if (c.State === "running") {
        sessions.set(sessionId, { containerId: c.Id, userId, lastActivity: Date.now() });
        console.log(`[recover] found running sandbox ${sessionId}`);
      } else {
        // Clean up stopped containers from previous runs
        docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
        console.log(`[recover] removed stopped sandbox ${sessionId}`);
      }
    }
  } catch (e) {
    console.error("[recover] failed:", e.message);
  }
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

  // Health is public so container orchestrators (compose/Coolify healthchecks)
  // can probe it without the secret. It exposes nothing sensitive.
  if (method === "GET" && path === "/health") {
    return jsonRes(res, 200, { ok: true, sessions: sessions.size });
  }

  if (!safeEqual(req.headers.authorization || "", `Bearer ${SECRET}`)) {
    return jsonRes(res, 401, { error: "Unauthorized" });
  }

  try {
    // POST /sessions — create sandbox
    if (method === "POST" && path === "/sessions") {
      const { sessionId, userId, networkMode } = await parseBody(req);
      if (!sessionId || !userId) return jsonRes(res, 400, { error: "Missing sessionId or userId" });

      // Existing session — verify same user, then reuse or restart
      if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.userId !== sanitize(userId)) {
          return jsonRes(res, 403, { error: "Session belongs to another user" });
        }
        const restarted = await restartSandbox(sessionId);
        if (restarted) {
          restarted.lastActivity = Date.now();
          await ensureMounts(existing.userId, sessionId); // repair perms on reuse
          return jsonRes(res, 200, { sessionId, status: "reused" });
        }
        // Container gone — fall through to create new one
      }

      // Per-user session limit — evict least recently used idle session
      const uid = sanitize(userId);
      const userSessions = [...sessions.entries()].filter(([, s]) => s.userId === uid);
      if (userSessions.length >= MAX_SESSIONS_PER_USER) {
        const now = Date.now();
        const ACTIVE_THRESHOLD = 60_000; // skip sessions used in last 60s
        const idle = userSessions.filter(([, s]) => now - s.lastActivity > ACTIVE_THRESHOLD);
        const victim = idle.length > 0
          ? idle.reduce((min, cur) => cur[1].lastActivity < min[1].lastActivity ? cur : min)
          : userSessions.reduce((min, cur) => cur[1].lastActivity < min[1].lastActivity ? cur : min);
        const [oldId, oldSession] = victim;
        try { const c = docker.getContainer(oldSession.containerId); await c.stop({ t: 2 }); await c.remove(); } catch { /* already gone */ }
        sessions.delete(oldId);
        console.log(`[sandbox] evicted session ${oldId} for user ${uid} (idle: ${now - oldSession.lastActivity}ms)`);
      }

      await createSandbox(sessionId, userId, networkMode);
      return jsonRes(res, 201, { sessionId, status: "created" });
    }

    // POST /sessions/:id/exec — execute command
    const execMatch = path.match(/^\/sessions\/([^/]+)\/exec$/);
    if (method === "POST" && execMatch) {
      const session = sessions.get(execMatch[1]);
      if (!session) return jsonRes(res, 404, { error: "Session not found" });
      const { command, timeout } = await parseBody(req);
      if (!command) return jsonRes(res, 400, { error: "Missing command" });
      session.lastActivity = Date.now();
      const result = await execInSandbox(session.containerId, command, timeout || EXEC_TIMEOUT);
      return jsonRes(res, 200, result);
    }

    // GET /sessions/:id/files?path=. — list directory (native fs, no exec)
    const filesMatch = path.match(/^\/sessions\/([^/]+)\/files$/);
    if (method === "GET" && filesMatch) {
      const resolved = resolveWsBase(filesMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (resolved.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (resolved.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      if (resolved.session) resolved.session.lastActivity = Date.now();

      const wsBase = resolved.wsBase;
      const relPath = url.searchParams.get("path") || ".";
      const dirPath = await safeRealPath(wsBase, relPath);

      const names = await readdir(dirPath).catch(() => []);
      const entries = [];
      for (const name of names) {
        try {
          const fullPath = join(dirPath, name);
          const s = await stat(fullPath);
          entries.push({
            name,
            path: relPath === "." ? name : `${relPath}/${name}`,
            isDirectory: s.isDirectory(),
            size: s.size,
            modifiedAt: s.mtime.toISOString(),
          });
        } catch { /* skip inaccessible */ }
      }
      return jsonRes(res, 200, { entries });
    }

    // GET /sessions/:id/download?path=file — stream file binary (native fs)
    const dlMatch = path.match(/^\/sessions\/([^/]+)\/download$/);
    if (method === "GET" && dlMatch) {
      const resolved = resolveWsBase(dlMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (resolved.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (resolved.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      if (resolved.session) resolved.session.lastActivity = Date.now();

      const wsBase = resolved.wsBase;
      const filePath = url.searchParams.get("path");
      if (!filePath) return jsonRes(res, 400, { error: "Missing path" });

      const fullPath = await safeRealPath(wsBase, filePath);
      const fileStat = await stat(fullPath).catch(() => null);
      if (!fileStat || fileStat.isDirectory()) return jsonRes(res, 404, { error: "File not found" });

      const rawName = basename(fullPath);
      const safeName = rawName.replace(/[^\x20-\x7E]/g, "_"); // ASCII-safe fallback
      const encodedName = encodeURIComponent(rawName);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": fileStat.size,
        "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
      });
      await pipeline(createReadStream(fullPath), res);
      return;
    }

    // POST /sessions/:id/upload — upload file (multipart)
    const upMatch = path.match(/^\/sessions\/([^/]+)\/upload$/);
    if (method === "POST" && upMatch) {
      const resolved = resolveWsBase(upMatch[1], url.searchParams.get("userId"), url.searchParams.get("token"));
      if (resolved.missing) return jsonRes(res, 400, { error: "Missing userId" });
      if (resolved.forbidden) return jsonRes(res, 403, { error: "Invalid or missing workspace token" });
      if (resolved.session) resolved.session.lastActivity = Date.now();

      const wsBase = resolved.wsBase;

      // Collect the full body, bounded by MAX_UPLOAD, then parse it. Parsing is
      // delegated to the tested multipart module so binary payloads (PNG/ZIP/PDF)
      // survive byte-for-byte rather than being mangled by ad-hoc string slicing.
      const contentType = req.headers["content-type"] || "";
      const chunks = [];
      let totalSize = 0;
      const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD) return jsonRes(res, 413, { error: `File too large (max ${MAX_UPLOAD_MB}MB)` });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      const parsed = parseMultipart(body, contentType);
      if (!parsed) return jsonRes(res, 400, { error: "Missing multipart boundary" });

      const targetPath = (parsed.fields.path ?? "").trim() || ".";
      const file = parsed.files.find((f) => f.field === "file") ?? parsed.files[0];
      if (!file) return jsonRes(res, 400, { error: "No file in request" });
      const fileData = file.data;
      const fileName = file.filename || "upload";

      // Check workspace disk quota
      const currentSize = await dirSize(wsBase);
      if (currentSize + fileData.length > MAX_WORKSPACE_MB * 1024 * 1024) {
        return jsonRes(res, 413, { error: `Workspace quota exceeded (max ${MAX_WORKSPACE_MB}MB)` });
      }

      const destDir = safeJoin(wsBase, targetPath === "." ? "" : targetPath);
      await mkdir(destDir, { recursive: true });
      const destFile = join(await safeRealPath(wsBase, targetPath === "." ? "" : targetPath), basename(fileName));

      const ws = createWriteStream(destFile);
      ws.end(fileData);
      await new Promise((resolve, reject) => { ws.on("finish", resolve); ws.on("error", reject); });

      return jsonRes(res, 200, { ok: true, path: targetPath === "." ? fileName : `${targetPath}/${fileName}`, name: fileName });
    }

    // DELETE /sessions/:id — destroy sandbox
    const deleteMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      await destroySandbox(deleteMatch[1]);
      return jsonRes(res, 200, { ok: true });
    }

    // GET /sessions — list active sessions
    if (method === "GET" && path === "/sessions") {
      const list = [];
      for (const [id, s] of sessions) list.push({ id, userId: s.userId, lastActivity: s.lastActivity });
      return jsonRes(res, 200, list);
    }

    jsonRes(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(`[error] ${method} ${path}:`, e.message);
    if (!res.headersSent) jsonRes(res, 500, { error: e.message });
  }
});

recoverSessions().then(() => {
  server.listen(PORT, () => console.log(`[sandbox-controller] listening on :${PORT}`));
});
