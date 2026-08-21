import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { createMcpBridge, sanitizeEnv } from "./mcp-bridge.js";

// A Docker stub whose exec produces a stream we control — enough to exercise the
// bridge's lifecycle (start → pending rpc → teardown) without a real container.
function fakeDocker() {
  const stream = new PassThrough();
  const execOpts = []; // what the bridge actually asked Docker to run
  return {
    stream,
    execOpts,
    modem: { demuxStream: () => {} }, // no server output in these tests
    getContainer: () => ({
      exec: async (opts) => { execOpts.push(opts); return { start: async () => stream }; },
    }),
  };
}

describe("mcp-bridge teardown", () => {
  it("stopAll rejects in-flight RPCs immediately instead of leaving them to time out", async () => {
    const docker = fakeDocker();
    const bridge = createMcpBridge(docker, { rpcTimeoutMs: 60_000 });
    await bridge.start("h1", "srv", { command: "server" });

    // A request with an id parks a pending promise (the fake server never answers).
    const pending = bridge.rpc("h1", "srv", { jsonrpc: "2.0", id: 1, method: "tools/list" });

    // Destroying the session must settle it now — not after the 60s rpc timeout.
    bridge.stopAll("h1");
    await expect(pending).rejects.toThrow(/destroyed/);
  });

  it("a second stopAll is a no-op (idempotent teardown)", async () => {
    const docker = fakeDocker();
    const bridge = createMcpBridge(docker);
    await bridge.start("h1", "srv", { command: "server" });
    bridge.stopAll("h1");
    expect(() => bridge.stopAll("h1")).not.toThrow();
    // The server is gone, so a subsequent rpc reports "not started".
    await expect(bridge.rpc("h1", "srv", { id: 2 })).rejects.toThrow(/not started/);
  });

  it("sanitizeEnv drops loader-influencing names", () => {
    const out = sanitizeEnv({ LD_PRELOAD: "x", PATH: "/bad", TOKEN: "ok", NODE_OPTIONS: "--eval" });
    expect(out).toEqual({ TOKEN: "ok" });
  });

  it("sanitizeEnv drops the names the controller owns, whatever their case", () => {
    const out = sanitizeEnv({
      HOME: "/workspace", home: "/workspace",
      npm_config_cache: "/workspace/.npm", NPM_CONFIG_USERCONFIG: "/workspace/.npmrc",
      UV_CACHE_DIR: "/workspace/.uv", XDG_CONFIG_HOME: "/workspace",
      TOKEN: "ok",
    });
    expect(out).toEqual({ TOKEN: "ok" });
  });

  // The exec's environment is the thing that actually matters, and it used to be
  // decided by object-spread order: caller env came last and overrode HOME. A
  // connector spec that redirects HOME to an agent-writable directory gets its
  // .bash_profile sourced by the `bash -lc` below — running as the mcp uid, with
  // this connector's secrets in scope.
  it("start() pins HOME to the mcp tmpfs even when the spec tries to move it", async () => {
    const docker = fakeDocker();
    const bridge = createMcpBridge(docker, { user: "1001:1001" });
    await bridge.start("h1", "srv", {
      command: "server",
      env: { HOME: "/workspace", XDG_CACHE_HOME: "/workspace", TOKEN: "keep-me" },
    });

    const env = Object.fromEntries(docker.execOpts[0].Env.map((e) => e.split(/=(.*)/s).slice(0, 2)));
    expect(env.HOME).toBe("/opt/mcp");
    expect(env.XDG_CACHE_HOME).toBe("/opt/mcp/.cache");
    expect(env.TOKEN).toBe("keep-me"); // the connector's own secrets still pass
    // And it really is a login shell, which is why the above has to hold.
    expect(docker.execOpts[0].Cmd[1]).toContain("-l");
  });
});
