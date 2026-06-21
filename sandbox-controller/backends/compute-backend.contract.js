import { describe, it, expect } from "vitest";

/** Shared behavioral contract every ComputeBackend implementation must satisfy.
 *  Requires a real backend (Docker daemon etc.) — drive it from a guarded
 *  integration test, not from unit tests.
 *  @param {() => any} makeBackend */
export function runComputeBackendContract(makeBackend) {
  describe("ComputeBackend contract", () => {
    it("create() returns a handle then list() finds the session", async () => {
      const b = makeBackend();
      const { handle } = await b.create({
        sessionId: "ct-s1", userId: "u1", wsHostPath: "/tmp/ws", sharedHostPath: "/tmp/sh",
        networkMode: "none", memoryBytes: 384 * 1024 * 1024, nanoCpus: 1e9,
      });
      expect(handle).toBeTruthy();
      const found = (await b.list()).find((r) => r.sessionId === "ct-s1");
      expect(found?.handle).toBe(handle);
      await b.destroy(handle);
    });

    it("exec() runs a command and returns exit code + stdout", async () => {
      const b = makeBackend();
      const { handle } = await b.create({
        sessionId: "ct-s2", userId: "u1", wsHostPath: "/tmp/ws", sharedHostPath: "/tmp/sh",
        networkMode: "none", memoryBytes: 384 * 1024 * 1024, nanoCpus: 1e9,
      });
      const r = await b.exec(handle, "echo hi", 10000);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hi");
      await b.destroy(handle);
    });
  });
}
