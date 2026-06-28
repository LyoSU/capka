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
});

describe("sandbox tools — output truncation safeguards", () => {
  beforeEach(() => {
    execCommand.mockReset();
    execCommand.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
  });

  it("clips an oversized command output to a recoverable 'clip' state with a narrowing hint", async () => {
    execCommand.mockResolvedValue({ stdout: "A".repeat(200_000), stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "cat big.log" }, opts)) as {
      output: string; truncated: string;
    };
    expect(res.truncated).toBe("clip");
    expect(res.output.length).toBeLessThan(200_000);
    expect(res.output).toContain("TRUNCATED");
    expect(res.output).toContain("read_file"); // actionable recovery advice
  });

  it("surfaces a controller-side discard as a non-recoverable 'discarded' state", async () => {
    execCommand.mockResolvedValue({ stdout: "partial output", stderr: "", exitCode: 0, truncated: true });
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "yes" }, opts)) as {
      output: string; truncated: string;
    };
    expect(res.truncated).toBe("discarded");
    expect(res.output).toContain("DISCARDED"); // tells the model the rest is gone, not paginable
  });

  it("a normal result reports truncated: none", async () => {
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "echo hi" }, opts)) as { truncated: string };
    expect(res.truncated).toBe("none");
  });

  it("read_file reads a bounded window with sed and supports offset paging", async () => {
    execCommand.mockResolvedValue({ stdout: "a\nb\nc\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    await tools.read_file.execute!({ path: "f.txt", max_lines: 50, offset: 10 }, opts);
    const cmd = lastCmd();
    // window starts at line 10, sentinel line at 60, then quits
    expect(cmd).toBe("sed -n '10,60p;60q' 'f.txt'");
  });

  it("read_file flags more-to-come and points at the next offset", async () => {
    // 3 lines returned for a 2-line window → the sentinel proves more follows.
    execCommand.mockResolvedValue({ stdout: "l1\nl2\nl3\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.read_file.execute!({ path: "f.txt", max_lines: 2 }, opts)) as {
      content: string; truncated: boolean;
    };
    expect(res.truncated).toBe(true);
    expect(res.content).toContain("offset=3"); // resume point
    expect(res.content).not.toContain("l3"); // sentinel line not shown
  });

  it("search_files marks a capped match list instead of silently hiding extras", async () => {
    execCommand.mockResolvedValue({ stdout: Array.from({ length: 101 }, (_, i) => `m${i}`).join("\n"), stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.search_files.execute!({ pattern: "x" }, opts)) as {
      matches: string; truncated: boolean;
    };
    expect(res.truncated).toBe(true);
    expect(res.matches).toContain("first 100 matches");
    expect(res.matches).not.toContain("m100"); // the 101st is dropped from the shown set
  });
});

describe("sandbox tools — capture full output to a workspace log file", () => {
  beforeEach(() => {
    execCommand.mockReset();
    execCommand.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
  });

  it("execute_bash mirrors output to a rotated log under .unclaw/output via tee", async () => {
    const { tools } = await load();
    await tools.execute_bash.execute!({ command: "echo hi" }, opts);
    const cmd = lastCmd();
    expect(cmd).toContain("/workspace/.unclaw/output");
    expect(cmd).toContain("tee");
    expect(cmd).toContain("echo hi"); // the user command is embedded intact
  });

  it("points the model at the saved log (not 're-run') when output was clipped", async () => {
    execCommand.mockResolvedValue({
      stdout: "X".repeat(200_000),
      stderr: "\x1e204800\x1e/workspace/.unclaw/output/123.log\n",
      exitCode: 0,
    });
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "cat big" }, opts)) as {
      output: string; truncated: string; logPath?: string;
    };
    expect(res.truncated).toBe("clip");
    expect(res.logPath).toBe("/workspace/.unclaw/output/123.log");
    expect(res.output).toContain("saved at /workspace/.unclaw/output/123.log");
  });

  it("keeps no log and stays 'none' when output fit inline (trailer path is '-')", async () => {
    execCommand.mockResolvedValue({ stdout: "small", stderr: "\x1e5\x1e-\n", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "echo small" }, opts)) as {
      output: string; truncated: string; logPath?: string;
    };
    expect(res.truncated).toBe("none");
    expect(res.logPath).toBeUndefined();
    expect(res.output).toBe("small");
  });
});

describe("sandbox tools — delete_path", () => {
  beforeEach(() => {
    execCommand.mockReset();
    deleteFile.mockReset();
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
