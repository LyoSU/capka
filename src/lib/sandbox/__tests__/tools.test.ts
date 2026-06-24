import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the shell command each tool sends to the sandbox without touching a
// real controller. The point of these tests: the model's core file/code tools
// must NOT depend on writable /tmp scratch space — a sibling process filling the
// 64 MB /tmp tmpfs must never break editing files that live in /workspace.
const { execCommand, deleteFile } = vi.hoisted(() => ({ execCommand: vi.fn(), deleteFile: vi.fn() }));
vi.mock("../client", () => ({ execCommand, deleteFile }));

import { loadSandboxTools } from "../tools";

const lastCmd = (): string => execCommand.mock.calls.at(-1)![1] as string;
const load = () => loadSandboxTools("sess1", async () => {});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opts = {} as any;

describe("sandbox tools never rely on /tmp scratch space", () => {
  beforeEach(() => {
    execCommand.mockReset();
    execCommand.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
  });

  it("execute_python pipes code via stdin, never writing to /tmp", async () => {
    const { tools } = await load();
    await tools.execute_python.execute!({ code: "print(1)" }, opts);
    const cmd = lastCmd();
    expect(cmd).not.toContain("/tmp");
    expect(cmd).toMatch(/\|\s*python3\s+-/);
  });

  it("execute_node pipes code via stdin, never writing to /tmp", async () => {
    const { tools } = await load();
    await tools.execute_node.execute!({ code: "console.log(1)" }, opts);
    const cmd = lastCmd();
    expect(cmd).not.toContain("/tmp");
    expect(cmd).toMatch(/\|\s*node\b/);
  });

  it("str_replace pipes its helper script via stdin, never writing to /tmp", async () => {
    const { tools } = await load();
    await tools.str_replace.execute!({ path: "a.txt", old_str: "x", new_str: "y" }, opts);
    const cmd = lastCmd();
    expect(cmd).not.toContain("/tmp");
    expect(cmd).toMatch(/\|\s*python3\s+-/);
  });

  it("propagates a non-zero exit code from the sandbox as failure", async () => {
    execCommand.mockResolvedValue({ stdout: "", stderr: "boom", exitCode: 1 });
    const { tools } = await load();
    const res = (await tools.execute_python.execute!({ code: "x" }, opts)) as {
      success: boolean;
      exitCode: number;
    };
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
  });
});

describe("sandbox tools — workspace-full (quota) recovery", () => {
  beforeEach(() => {
    execCommand.mockReset();
    deleteFile.mockReset();
  });

  it("turns a 413 quota block into a normal failed result (no throw) so the model recovers in-run", async () => {
    const msg = "Workspace is full (max 500MB). Use the delete_path tool to remove large files or folders, then continue.";
    execCommand.mockRejectedValue(Object.assign(new Error(msg), { status: 413 }));
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "dd if=/dev/zero of=big" }, opts)) as {
      output: string; success: boolean;
    };
    expect(res.success).toBe(false);
    expect(res.output).toContain("delete_path"); // the actionable message reached the model
  });

  it("re-throws non-quota errors — the 413 escape must not swallow real failures", async () => {
    execCommand.mockRejectedValue(Object.assign(new Error("controller down"), { status: 502 }));
    const { tools } = await load();
    await expect(tools.execute_bash.execute!({ command: "ls" }, opts)).rejects.toThrow("controller down");
  });

  it("delete_path frees space via the ungated delete endpoint (handles files and folders)", async () => {
    deleteFile.mockResolvedValue({ ok: true });
    const { tools } = await load();
    const res = (await tools.delete_path.execute!({ path: "venv" }, opts)) as { success: boolean; path: string };
    expect(deleteFile).toHaveBeenCalledWith("sess1", "venv");
    expect(res).toEqual({ success: true, path: "venv" });
  });

  it("delete_path reports a friendly failure instead of throwing", async () => {
    deleteFile.mockRejectedValue(new Error("nope"));
    const { tools } = await load();
    const res = (await tools.delete_path.execute!({ path: "x" }, opts)) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe("nope");
  });
});
