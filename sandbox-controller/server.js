import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat, mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, resolve, basename } from "node:path";
import Docker from "dockerode";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const PORT = process.env.PORT || 3001;
const SECRET = process.env.CONTROLLER_SECRET || "unclaw-sandbox-secret";

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "unclaw-sandbox";
const MEMORY_LIMIT = parseInt(process.env.SANDBOX_MEMORY_MB || "512") * 1024 * 1024;
const CPU_LIMIT = parseFloat(process.env.SANDBOX_CPUS || "1.0") * 1e9;
const EXEC_TIMEOUT = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || "30000");
const IDLE_TTL = parseInt(process.env.SANDBOX_IDLE_TTL_MS || "900000"); // 15 min
const DATA_ROOT = process.env.DATA_ROOT || resolve(import.meta.dirname, "..", "data", "storage");
const MAX_SESSIONS_PER_USER = parseInt(process.env.MAX_SESSIONS_PER_USER || "5");
const MAX_WORKSPACE_MB = parseInt(process.env.MAX_WORKSPACE_MB || "500");
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "100");

// Active sessions: sessionId -> { containerId, userId, lastActivity }
const sessions = new Map();

/** Sanitize IDs to prevent path traversal and Docker name injection */
function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

/** Resolve workspace path on host, with traversal protection */
function workspacePath(userId, sessionId) {
  return resolve(DATA_ROOT, sanitize(userId), sanitize(sessionId), "sandbox");
}

function safeJoin(base, userPath) {
  const full = resolve(base, userPath);
  // Must start with base + separator (not just prefix match)
  if (full !== base && !full.startsWith(base + "/")) throw new Error("Path traversal blocked");
  return full;
}

/** Resolve real path and verify it's still within base (blocks symlink escapes) */
async function safeRealPath(base, userPath) {
  const full = safeJoin(base, userPath);
  // For operations that read existing files, resolve symlinks
  const { realpath } = await import("node:fs/promises");
  try {
    const real = await realpath(full);
    if (real !== base && !real.startsWith(base + "/")) throw new Error("Symlink escape blocked");
    return real;
  } catch (e) {
    if (e.code === "ENOENT") return full; // file doesn't exist yet (write ops)
    throw e;
  }
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

async function createSandbox(sessionId, userId) {
  sessionId = sanitize(sessionId);
  userId = sanitize(userId);
  const wsPath = workspacePath(userId, sessionId);

  // Ensure workspace dir exists
  await mkdir(wsPath, { recursive: true });

  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    name: `sandbox-${sessionId}`,
    Env: ["DISPLAY=:99", "PYTHONUNBUFFERED=1", "LANG=C.UTF-8"],
    HostConfig: {
      Memory: MEMORY_LIMIT,
      NanoCpus: CPU_LIMIT,
      PidsLimit: 100,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
      NetworkMode: "none",
      Binds: [`${wsPath}:/workspace`],
      Init: true,
    },
    User: "1000:1000",
    WorkingDir: "/workspace",
    Tty: false,
    Labels: {
      "unclaw.session": sessionId,
      "unclaw.user": userId,
    },
  });

  await container.start();

  const session = { containerId: container.id, userId, lastActivity: Date.now() };
  sessions.set(sessionId, session);
  return session;
}

async function execInSandbox(containerId, command, timeout = EXEC_TIMEOUT) {
  const container = docker.getContainer(containerId);

  const execObj = await container.exec({
    Cmd: ["bash", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    User: "1000:1000",
    WorkingDir: "/workspace",
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      try {
        const info = await execObj.inspect();
        if (info.Running) {
          const killExec = await container.exec({ Cmd: ["kill", "-9", String(info.Pid)], User: "root" });
          await killExec.start({});
        }
      } catch { /* best effort */ }
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

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
  if (req.headers.authorization !== `Bearer ${SECRET}`) {
    return jsonRes(res, 401, { error: "Unauthorized" });
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // POST /sessions — create sandbox
    if (method === "POST" && path === "/sessions") {
      const { sessionId, userId } = await parseBody(req);
      if (!sessionId || !userId) return jsonRes(res, 400, { error: "Missing sessionId or userId" });
      if (sessions.has(sessionId)) {
        sessions.get(sessionId).lastActivity = Date.now();
        return jsonRes(res, 200, { sessionId, status: "reused" });
      }

      // Per-user session limit
      const userSessions = [...sessions.values()].filter((s) => s.userId === sanitize(userId));
      if (userSessions.length >= MAX_SESSIONS_PER_USER) {
        return jsonRes(res, 429, { error: `Max ${MAX_SESSIONS_PER_USER} active sandboxes per user` });
      }

      await createSandbox(sessionId, userId);
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
      const session = sessions.get(filesMatch[1]);
      if (!session) return jsonRes(res, 404, { error: "Session not found" });
      session.lastActivity = Date.now();

      const wsBase = workspacePath(session.userId, filesMatch[1]);
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
      const session = sessions.get(dlMatch[1]);
      if (!session) return jsonRes(res, 404, { error: "Session not found" });
      session.lastActivity = Date.now();

      const wsBase = workspacePath(session.userId, dlMatch[1]);
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
      const session = sessions.get(upMatch[1]);
      if (!session) return jsonRes(res, 404, { error: "Session not found" });
      session.lastActivity = Date.now();

      const wsBase = workspacePath(session.userId, upMatch[1]);

      // Parse multipart boundary
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) return jsonRes(res, 400, { error: "Missing multipart boundary" });

      // Collect full body
      const chunks = [];
      let totalSize = 0;
      const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD) return jsonRes(res, 413, { error: "File too large (max 100MB)" });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);

      // Simple multipart parsing — extract path and file fields
      const boundary = `--${boundaryMatch[1]}`;
      const parts = [];
      let start = body.indexOf(boundary) + boundary.length;
      while (start < body.length) {
        const nextBoundary = body.indexOf(boundary, start);
        if (nextBoundary === -1) break;
        parts.push(body.slice(start, nextBoundary));
        start = nextBoundary + boundary.length;
      }

      let targetPath = ".";
      let fileData = null;
      let fileName = "upload";

      for (const part of parts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString("utf8");
        const content = part.slice(headerEnd + 4, part.length - 2); // trim trailing \r\n

        if (headers.includes('name="path"')) {
          targetPath = content.toString("utf8").trim();
        } else if (headers.includes('name="file"')) {
          fileData = content;
          const fnMatch = headers.match(/filename="([^"]+)"/);
          if (fnMatch) fileName = fnMatch[1];
        }
      }

      if (!fileData) return jsonRes(res, 400, { error: "No file in request" });

      // Check workspace disk quota
      const currentSize = await dirSize(wsBase);
      if (currentSize + fileData.length > MAX_WORKSPACE_MB * 1024 * 1024) {
        return jsonRes(res, 413, { error: `Workspace quota exceeded (max ${MAX_WORKSPACE_MB}MB)` });
      }

      const destDir = safeJoin(wsBase, targetPath === "." ? "" : targetPath);
      await mkdir(destDir, { recursive: true });
      const destFile = join(destDir, basename(fileName));

      // Ensure dest is still within workspace
      if (!destFile.startsWith(wsBase)) return jsonRes(res, 400, { error: "Invalid path" });

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

    // GET /health
    if (method === "GET" && path === "/health") {
      return jsonRes(res, 200, { ok: true, sessions: sessions.size });
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
