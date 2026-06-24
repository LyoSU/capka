import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the shell command each tool sends to the sandbox without touching a
// real controller. The point of these tests: the model's core file/code tools
// must NOT depend on writable /tmp scratch space — a sibling process filling the
// 64 MB /tmp tmpfs must never break editing files that live in /workspace.
const { execCommand } = vi.hoisted(() => ({ execCommand: vi.fn() }));
vi.mock("../client", () => ({ execCommand }));

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
