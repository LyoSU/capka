import { createServer } from "node:http";
import Docker from "dockerode";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const PORT = process.env.PORT || 3001;
const SECRET = process.env.CONTROLLER_SECRET || "changeme";

// Configurable defaults
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "unclaw-sandbox";
const MEMORY_LIMIT = parseInt(process.env.SANDBOX_MEMORY_MB || "512") * 1024 * 1024;
const CPU_LIMIT = parseFloat(process.env.SANDBOX_CPUS || "1.0") * 1e9;
const EXEC_TIMEOUT = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || "30000");
const IDLE_TTL = parseInt(process.env.SANDBOX_IDLE_TTL_MS || "900000"); // 15 min
const DATA_ROOT = process.env.DATA_ROOT || "/data/storage";

// Active sessions: sessionId -> { containerId, userId, lastActivity }
const sessions = new Map();

// --- Docker helpers ---

async function createSandbox(sessionId, userId) {
  const workspacePath = `${DATA_ROOT}/${userId}/${sessionId}/sandbox`;

  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    name: `sandbox-${sessionId}`,
    HostConfig: {
      Memory: MEMORY_LIMIT,
      NanoCpus: CPU_LIMIT,
      PidsLimit: 100,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
      NetworkMode: "none",
      Binds: [`${workspacePath}:/workspace`],
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

  const session = {
    containerId: container.id,
    userId,
    lastActivity: Date.now(),
  };
  sessions.set(sessionId, session);
  return session;
}

async function execInSandbox(containerId, command, timeout = EXEC_TIMEOUT) {
  const container = docker.getContainer(containerId);

  // NOTE: command is intentionally passed as a single bash -c string because
  // this is a sandboxed container — the container IS the security boundary.
  // The AI agent needs full shell capabilities (pipes, redirects, etc.)
  const execObj = await container.exec({
    Cmd: ["bash", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    User: "1000:1000",
    WorkingDir: "/workspace",
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    execObj.start({ hijack: true }, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }

      let stdout = "";
      let stderr = "";

      // Docker multiplexed stream: 8-byte header per frame
      stream.on("data", (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) break;
          const type = chunk[offset]; // 1=stdout, 2=stderr
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
          resolve({
            stdout: stdout.slice(0, 100_000),
            stderr: stderr.slice(0, 50_000),
            exitCode: info.ExitCode,
          });
        } catch {
          resolve({ stdout, stderr, exitCode: -1 });
        }
      });

      stream.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
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
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ["unclaw.session"] },
    });
    for (const c of containers) {
      const sessionId = c.Labels["unclaw.session"];
      const userId = c.Labels["unclaw.user"];
      if (c.State === "running") {
        sessions.set(sessionId, {
          containerId: c.Id,
          userId,
          lastActivity: Date.now(),
        });
        console.log(`[recover] found running sandbox ${sessionId}`);
      }
    }
  } catch (e) {
    console.error("[recover] failed:", e.message);
  }
}

// --- HTTP API ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  // Auth check
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${SECRET}`) {
    return json(res, 401, { error: "Unauthorized" });
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // POST /sessions — create sandbox
    if (method === "POST" && path === "/sessions") {
      const { sessionId, userId } = await parseBody(req);
      if (!sessionId || !userId) return json(res, 400, { error: "Missing sessionId or userId" });

      // Reuse existing session
      if (sessions.has(sessionId)) {
        sessions.get(sessionId).lastActivity = Date.now();
        return json(res, 200, { sessionId, status: "reused" });
      }

      await createSandbox(sessionId, userId);
      return json(res, 201, { sessionId, status: "created" });
    }

    // POST /sessions/:id/exec — execute command
    const execMatch = path.match(/^\/sessions\/([^/]+)\/exec$/);
    if (method === "POST" && execMatch) {
      const sessionId = execMatch[1];
      const session = sessions.get(sessionId);
      if (!session) return json(res, 404, { error: "Session not found" });

      const { command, timeout } = await parseBody(req);
      if (!command) return json(res, 400, { error: "Missing command" });

      session.lastActivity = Date.now();
      const result = await execInSandbox(session.containerId, command, timeout || EXEC_TIMEOUT);
      return json(res, 200, result);
    }

    // DELETE /sessions/:id — destroy sandbox
    const deleteMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      await destroySandbox(deleteMatch[1]);
      return json(res, 200, { ok: true });
    }

    // GET /sessions — list active sessions
    if (method === "GET" && path === "/sessions") {
      const list = [];
      for (const [id, s] of sessions) {
        list.push({ id, userId: s.userId, lastActivity: s.lastActivity });
      }
      return json(res, 200, list);
    }

    // GET /health
    if (method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, sessions: sessions.size });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(`[error] ${method} ${path}:`, e.message);
    json(res, 500, { error: e.message });
  }
});

recoverSessions().then(() => {
  server.listen(PORT, () => {
    console.log(`[sandbox-controller] listening on :${PORT}`);
  });
});
