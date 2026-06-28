import { PassThrough } from "node:stream";

// Caller-supplied MCP env is untrusted: a connector spec can come from a user.
// Drop names that influence how the shell/interpreter loads code, so a spec can't
// inject a library/preload/script into the in-sandbox process (which runs as the
// separate `mcp` uid and would otherwise honor e.g. LD_PRELOAD or BASH_ENV).
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/i;
const ENV_BLOCK = new Set([
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "BASH_ENV", "ENV", "IFS", "PS4", "SHELLOPTS", "BASHOPTS",
  "PATH", "PYTHONPATH", "PYTHONSTARTUP", "NODE_OPTIONS", "NODE_PATH", "PERL5LIB", "RUBYOPT", "RUBYLIB",
]);
export function sanitizeEnv(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k) || k.startsWith("LD_") || k.startsWith("DYLD_") || ENV_BLOCK.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Bridges a stdio MCP server running INSIDE a sandbox container to the platform.
 *
 * The sandbox is never on the controller's network (NetworkMode none/bridge), so a
 * port can't be proxied — instead we ride the Docker control plane: a long-lived
 * `docker exec` with stdin attached runs the MCP server, and we shuttle newline-
 * delimited JSON-RPC frames over the hijacked stream. Responses are matched to
 * requests by JSON-RPC `id`. The process stays isolated in gVisor; only frames
 * cross the boundary. v1 is request/response only (server→client notifications are
 * dropped — tools/list + tools/call don't need them).
 */
export function createMcpBridge(docker, { user, rpcTimeoutMs = 60000 } = {}) {
  const live = new Map(); // `${handle}:${name}` -> entry

  // Single-quote-escape an argv so a login shell runs it verbatim (gives the
  // process a real PATH/HOME — a bare `docker exec` of "npx" otherwise can't find
  // node tooling and dies instantly).
  function shellJoin(argv) {
    return argv.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(" ");
  }

  async function start(handle, name, { command, args = [], env = {} }) {
    const key = `${handle}:${name}`;
    const cur = live.get(key);
    if (cur && !cur.closed) return;

    const container = docker.getContainer(handle);
    // /opt/mcp is the dedicated exec-allowed tmpfs (see sandbox-spec.js): writable,
    // ephemeral, and outside the agent's /workspace so it never pollutes the user's
    // files. npx/uvx install + run the server here.
    const MCP_HOME = "/opt/mcp";
    const Env = Object.entries({
      HOME: MCP_HOME,
      npm_config_cache: `${MCP_HOME}/.npm`,
      npm_config_update_notifier: "false",
      NPM_CONFIG_FUND: "false",
      UV_CACHE_DIR: `${MCP_HOME}/.uv`,
      XDG_CACHE_HOME: `${MCP_HOME}/.cache`,
      ...sanitizeEnv(env),
    }).map(([k, v]) => `${k}=${v}`);
    const exec = await container.exec({
      Cmd: ["bash", "-lc", `mkdir -p ${MCP_HOME} && exec ${shellJoin([command, ...args])}`],
      Env,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      ...(user ? { User: user } : {}),
      WorkingDir: "/workspace",
    });
    const stream = await exec.start({ hijack: true, stdin: true });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);

    const entry = { stream, pending: new Map(), buf: "", stderr: "", closed: false };
    live.set(key, entry);

    stdout.on("data", (chunk) => {
      entry.buf += chunk.toString("utf8");
      let idx;
      while ((idx = entry.buf.indexOf("\n")) >= 0) {
        const line = entry.buf.slice(0, idx).trim();
        entry.buf = entry.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id != null && entry.pending.has(msg.id)) {
          entry.pending.get(msg.id).resolve(msg);
          entry.pending.delete(msg.id);
        }
      }
    });
    // Keep the last of stderr so a crash (missing pkg, no network) is reportable.
    stderr.on("data", (chunk) => {
      entry.stderr = (entry.stderr + chunk.toString("utf8")).slice(-4000);
    });
    const fail = (err) => {
      entry.closed = true;
      const detail = entry.stderr.trim();
      const e = detail ? new Error(`${err.message}: ${detail.slice(-500)}`) : err;
      for (const p of entry.pending.values()) p.reject(e);
      entry.pending.clear();
      live.delete(key);
    };
    stream.on("close", () => fail(new Error("mcp server exited")));
    stream.on("error", (e) => fail(e instanceof Error ? e : new Error("mcp stream error")));
  }

  /** Send one JSON-RPC message. Returns the matching response, or null for a
   *  notification (no `id`). Throws if the server isn't started or times out. */
  async function rpc(handle, name, message) {
    const entry = live.get(`${handle}:${name}`);
    if (!entry || entry.closed) throw new Error("mcp server not started");
    entry.stream.write(JSON.stringify(message) + "\n");
    if (message == null || message.id == null) return null;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending.delete(message.id);
        reject(new Error("mcp rpc timed out"));
      }, rpcTimeoutMs);
      entry.pending.set(message.id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** Tear down every MCP process for a container (called on session destroy). */
  function stopAll(handle) {
    for (const [key, entry] of live) {
      if (key.startsWith(`${handle}:`)) {
        try { entry.stream.end(); } catch { /* already gone */ }
        live.delete(key);
      }
    }
  }

  return { start, rpc, stopAll };
}
