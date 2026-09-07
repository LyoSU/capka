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

    // The fifth argument of exec(): per-command environment, which is how a chat's
    // stored secrets reach a command without ever appearing in the command string
    // (and therefore without appearing in any log that records the command).
    // Asserted on a CHILD process, not on the exec's own shell, because that is the
    // property the feature depends on — the backend wraps every command in
    // `setsid bash -c`, so an Env that did not survive one fork would be useless.
    it("exec() passes env to the command and its children", async () => {
      const b = makeBackend();
      const { handle } = await b.create({
        sessionId: "ct-s4", userId: "u1", wsHostPath: "/tmp/ws", sharedHostPath: "/tmp/sh",
        networkMode: "none", memoryBytes: 384 * 1024 * 1024, nanoCpus: 1e9,
      });
      const r = await b.exec(handle, "bash -c 'printf %s \"$CT_TOKEN\"'", 10000, undefined, { CT_TOKEN: "ct-value" });
      expect(r.stdout).toContain("ct-value");
      // Control: the same command without the env sees nothing, so the assertion
      // above cannot pass on a backend that ignores the argument entirely.
      const plain = await b.exec(handle, "bash -c 'printf %s \"$CT_TOKEN\"'", 10000);
      expect(plain.stdout).not.toContain("ct-value");
      await b.destroy(handle);
    });

    // A cancelled turn must stop the WORK, not just stop waiting for it. This is
    // the only test that can prove that: the platform-side plumbing and the kill
    // script are both easy to get "green" against a mock while the real process
    // keeps running. The marker file is the witness — it is written only if the
    // command was allowed to finish.
    it("exec() aborted mid-run stops the command inside the sandbox", async () => {
      const b = makeBackend();
      const { handle } = await b.create({
        sessionId: "ct-s3", userId: "u1", wsHostPath: "/tmp/ws", sharedHostPath: "/tmp/sh",
        networkMode: "none", memoryBytes: 384 * 1024 * 1024, nanoCpus: 1e9,
      });
      const seen = async (f) => (await b.exec(handle, `test -f /tmp/${f}`, 10000)).exitCode === 0;

      // Control: the same shape of command, left alone, DOES write its marker —
      // otherwise the assertion below would pass even with the kill removed.
      await b.exec(handle, "sleep 1; touch /tmp/ct-ran", 20000);
      expect(await seen("ct-ran")).toBe(true);

      const ac = new AbortController();
      const running = b.exec(handle, "sleep 4; touch /tmp/ct-killed", 20000, ac.signal);
      await new Promise((r) => setTimeout(r, 700));
      ac.abort();
      await running.catch(() => {}); // settles once the group is gone
      await new Promise((r) => setTimeout(r, 5000)); // past the 4s it wanted
      expect(await seen("ct-killed")).toBe(false);

      await b.destroy(handle);
    }, 60_000);
  });
}
