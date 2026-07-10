import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { createMcpBridge, sanitizeEnv } from "./mcp-bridge.js";

// A Docker stub whose exec produces a stream we control — enough to exercise the
// bridge's lifecycle (start → pending rpc → teardown) without a real container.
function fakeDocker() {
  const stream = new PassThrough();
  return {
    stream,
    modem: { demuxStream: () => {} }, // no server output in these tests
    getContainer: () => ({
      exec: async () => ({ start: async () => stream }),
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
});
