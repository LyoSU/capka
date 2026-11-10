import { describe, it, expect, vi, beforeEach } from "vitest";

const { execCommand, markBusy } = vi.hoisted(() => ({
  execCommand: vi.fn(), markBusy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../client", () => ({ execCommand, deleteFile: vi.fn(), deleteSharedFile: vi.fn(), markBusy }));

import { loadSandboxTools } from "../tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opts = {} as any;
type Started = { started: boolean; jobId: string; note: string };

// The point of the notice: a model told "you will be notified" stops burning steps on
// a check_job/sleep loop. It may only be told that when the platform really watches.
describe("background start tells the model whether it will be notified", () => {
  beforeEach(() => {
    execCommand.mockReset();
    execCommand.mockResolvedValue({ stdout: "started", stderr: "", exitCode: 0 });
  });

  it("promises a notification and forbids polling when the job is recorded", async () => {
    const onStart = vi.fn().mockResolvedValue(true);
    const { tools } = await loadSandboxTools("s", "u", async () => {}, "none", undefined, undefined, onStart);
    const res = (await tools.execute_bash.execute!({ command: "sleep 900", background: true }, opts)) as Started;
    expect(onStart).toHaveBeenCalledWith({ jobId: res.jobId, command: "sleep 900" });
    expect(res.note).toContain("You will be notified automatically");
    expect(res.note).toContain("DO NOT poll check_job");
  });

  it("falls back to check_job when nothing will notify (no recorder, chain exhausted, or a failed insert)", async () => {
    for (const onStart of [undefined, vi.fn().mockResolvedValue(false), vi.fn().mockRejectedValue(new Error("db down"))]) {
      const { tools } = await loadSandboxTools("s", "u", async () => {}, "none", undefined, undefined, onStart);
      const res = (await tools.execute_bash.execute!({ command: "sleep 900", background: true }, opts)) as Started;
      expect(res.started).toBe(true);
      expect(res.note).not.toContain("notified automatically");
      expect(res.note).toContain("check_job");
    }
  });
});
