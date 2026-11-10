import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the shell command each tool sends to the sandbox without touching a
// real controller. The point of these tests: the model's core file/code tools
// must NOT depend on writable /tmp scratch space — a sibling process filling the
// 64 MB /tmp tmpfs must never break editing files that live in /workspace.
const { execCommand, deleteFile, markBusy } = vi.hoisted(() => ({
  execCommand: vi.fn(), deleteFile: vi.fn(),
  // Always thenable, like the real client call — tools await the lease.
  markBusy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../client", () => ({ execCommand, deleteFile, markBusy }));

import { loadSandboxTools } from "../tools";

const lastCmd = (): string => execCommand.mock.calls.at(-1)![1] as string;
const load = () => loadSandboxTools("sess1", "user1", async () => {});
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

  it("read_file turns a raw sed 'No such file' into a calm, path-first message", async () => {
    execCommand.mockResolvedValue({
      stdout: "",
      stderr: "sed: can't read /workspace/README.md: No such file or directory",
      exitCode: 2,
    });
    const { tools } = await load();
    const res = (await tools.read_file.execute!({ path: "README.md" }, opts)) as { error: string };
    expect(res.error).toBe("File not found: README.md");
    expect(res.error).not.toContain("sed"); // no shell jargon leaks to the card
  });

  it("read_file passes an unrecognized failure (e.g. over-quota) through unchanged", async () => {
    // The 413/WORKSPACE_FULL message is actionable — sanitizing must not swallow it.
    execCommand.mockResolvedValue({ stdout: "", stderr: "Workspace storage limit reached", exitCode: 1 });
    const { tools } = await load();
    const res = (await tools.read_file.execute!({ path: "big.csv" }, opts)) as { error: string };
    expect(res.error).toBe("Workspace storage limit reached");
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

  // A sandbox can die UNDER a command (gVisor's sentry is one host process, so a
  // pids-cgroup refusal or an OOM kill takes the whole sandbox with it). The
  // controller answers 409 SANDBOX_GONE and has already dropped its session record
  // — but this run's ensureSession is memoized, so without clearing it every
  // remaining command in the turn fails the same way. Recreating the container is
  // the recovery; re-running the command is NOT, because a half-applied
  // non-idempotent command would be silently repeated.
  it("turns a dead sandbox into an actionable failed result and clears the memo so the next call rebuilds", async () => {
    const msg = "The sandbox restarted, so this command did not run. Files in /workspace are intact; anything in /tmp and any running process is gone.";
    execCommand.mockRejectedValue(Object.assign(new Error(msg), { status: 409 }));
    const onSandboxGone = vi.fn();
    const { tools } = await loadSandboxTools("sess1", "user1", async () => {}, "none", onSandboxGone);
    const res = (await tools.execute_bash.execute!({ command: "ls" }, opts)) as {
      output: string; success: boolean;
    };
    expect(res.success).toBe(false);
    expect(res.output).toContain("/workspace are intact");
    expect(onSandboxGone).toHaveBeenCalledTimes(1);
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

  it("execute_bash mirrors output to a rotated log under .capka/output via tee", async () => {
    const { tools } = await load();
    await tools.execute_bash.execute!({ command: "echo hi" }, opts);
    const cmd = lastCmd();
    expect(cmd).toContain("/workspace/.capka/output");
    expect(cmd).toContain("tee");
    expect(cmd).toContain("echo hi"); // the user command is embedded intact
  });

  it("points the model at the saved log (not 're-run') when output was clipped", async () => {
    execCommand.mockResolvedValue({
      stdout: "X".repeat(200_000),
      stderr: "\x1e204800\x1e/workspace/.capka/output/123.log\n",
      exitCode: 0,
    });
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "cat big" }, opts)) as {
      output: string; truncated: string; logPath?: string;
    };
    expect(res.truncated).toBe("clip");
    expect(res.logPath).toBe("/workspace/.capka/output/123.log");
    expect(res.output).toContain("saved at /workspace/.capka/output/123.log");
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

describe("sandbox tools — background jobs", () => {
  beforeEach(() => {
    execCommand.mockReset();
    execCommand.mockResolvedValue({ stdout: "started", stderr: "", exitCode: 0 });
  });

  it("execute_bash(background) launches a detached, own-session job and returns a jobId at once", async () => {
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "sleep 400; echo done", background: true }, opts)) as {
      started: boolean; jobId: string; logPath: string;
    };
    const cmd = lastCmd();
    // detached in its own session, records exit code + pid, never blocks
    expect(cmd).toContain("setsid bash -c");
    expect(cmd).toContain("/workspace/.capka/jobs/");
    expect(cmd).toContain("exitcode");
    expect(cmd).toContain("/pid");
    // the user command travels base64'd (verbatim), not inline — so it can't break quoting
    expect(cmd).not.toContain("sleep 400; echo done");
    expect(cmd).toContain("base64 -d | bash");
    // NOT wrapped in the synchronous tee-capture path
    expect(cmd).not.toContain("tee");
    expect(res.started).toBe(true);
    expect(res.jobId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(res.logPath).toBe(`/workspace/.capka/jobs/${res.jobId}/log`);
  });

  it("check_job reports a finished job's exit code and log tail", async () => {
    execCommand.mockResolvedValue({ stdout: "__EXIT__0\n__LOG__\nhello from job\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.check_job.execute!({ jobId: "abc-123" }, opts)) as {
      running: boolean; exitCode: number; success: boolean; logTail: string;
    };
    expect(res.running).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.success).toBe(true);
    expect(res.logTail).toContain("hello from job");
  });

  it("check_job reports a still-running job (pid alive, no exit code yet)", async () => {
    execCommand.mockResolvedValue({ stdout: "__RUNNING__\n__LOG__\npartial\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.check_job.execute!({ jobId: "abc-123" }, opts)) as { running: boolean; logTail: string };
    expect(res.running).toBe(true);
    expect(res.logTail).toContain("partial");
  });

  it("check_job flags a job that died without recording an exit code", async () => {
    execCommand.mockResolvedValue({ stdout: "__DEAD__\n__LOG__\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.check_job.execute!({ jobId: "abc-123" }, opts)) as {
      running: boolean; exitCode: number | null; note: string;
    };
    expect(res.running).toBe(false);
    expect(res.exitCode).toBeNull();
    expect(res.note).toContain("killed");
  });

  it("check_job is not fooled by a job whose log echoes __EXIT__/__RUNNING__ markers", async () => {
    // status says RUNNING; the log tail happens to contain "__EXIT__0" — the parser
    // must read status from BEFORE __LOG__ only, so the job stays running.
    execCommand.mockResolvedValue({ stdout: "__RUNNING__\n__LOG__\nprogress: __EXIT__0 reached\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.check_job.execute!({ jobId: "abc-123" }, opts)) as { running: boolean; logTail: string };
    expect(res.running).toBe(true);
    expect(res.logTail).toContain("__EXIT__0"); // the marker survives in the log body, just isn't parsed as status
  });

  it("background rotation removes only FINISHED job dirs (never a running one)", async () => {
    const { tools } = await load();
    await tools.execute_bash.execute!({ command: "sleep 999", background: true }, opts);
    const cmd = lastCmd();
    // the rotation list is filtered to dirs that have an exitcode (i.e. finished)
    expect(cmd).toContain('[ -f "$d/exitcode" ]');
    // and the log is capped so a runaway can't fill the workspace
    expect(cmd).toMatch(/head -c \d+/);
  });

  it("check_job returns a friendly error for an unknown/rotated job", async () => {
    execCommand.mockResolvedValue({ stdout: "__NOJOB__\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.check_job.execute!({ jobId: "gone" }, opts)) as { error: string };
    expect(res.error).toContain("No job gone");
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
    expect(deleteFile).toHaveBeenCalledWith("sess1", "venv", "user1");
    expect(res).toEqual({ success: true, path: "venv" });
  });

  it("delete_path takes the /workspace/… form the model uses everywhere else, and never the root", async () => {
    deleteFile.mockResolvedValue({ ok: true });
    const { tools } = await load();
    await tools.delete_path.execute!({ path: "/workspace/_tmp/a.json" }, opts);
    expect(deleteFile).toHaveBeenLastCalledWith("sess1", "_tmp/a.json", "user1");
    await tools.delete_path.execute!({ path: "/workspace/" }, opts);
    expect(deleteFile).toHaveBeenLastCalledWith("sess1", "/workspace/", "user1");
  });

  it("delete_path reports a friendly failure instead of throwing", async () => {
    deleteFile.mockRejectedValue(new Error("nope"));
    const { tools } = await load();
    const res = (await tools.delete_path.execute!({ path: "x" }, opts)) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe("nope");
  });
});

// A detached job runs with nobody calling the controller, so without a lease the
// idle reaper reclaims the container mid-work and the job dies silently.
describe("background jobs lease the sandbox against idle eviction", () => {
  beforeEach(() => {
    execCommand.mockReset();
    markBusy.mockReset();
    markBusy.mockResolvedValue(undefined);
    execCommand.mockResolvedValue({ stdout: "started", stderr: "", exitCode: 0 });
  });

  it("takes a lease when a detached job starts", async () => {
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "sleep 600", background: true }, opts)) as {
      started: boolean;
    };
    expect(res.started).toBe(true);
    expect(markBusy).toHaveBeenCalledWith("sess1");
  });

  it("starts the job even when the lease call fails", async () => {
    markBusy.mockRejectedValue(new Error("controller unreachable"));
    const { tools } = await load();
    const res = (await tools.execute_bash.execute!({ command: "sleep 600", background: true }, opts)) as {
      started: boolean;
    };
    expect(res.started).toBe(true); // best-effort: a lease failure must not lose the job
  });

  it("renews the lease while check_job still reports the job running", async () => {
    execCommand.mockResolvedValue({ stdout: "__RUNNING__\n__LOG__\nworking", stderr: "", exitCode: 0 });
    const { tools } = await load();
    await tools.check_job.execute!({ jobId: "j1" }, opts);
    expect(markBusy).toHaveBeenCalledWith("sess1");
  });

  it("stops renewing once the job has finished", async () => {
    execCommand.mockResolvedValue({ stdout: "__EXIT__0\n__LOG__\ndone", stderr: "", exitCode: 0 });
    const { tools } = await load();
    await tools.check_job.execute!({ jobId: "j1" }, opts);
    expect(markBusy).not.toHaveBeenCalled(); // nothing left to protect
  });
});

describe("sandbox tools — str_replace uniqueness, search_files flags, default timeouts", () => {
  beforeEach(() => {
    execCommand.mockReset();
    execCommand.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
  });
  const script = () => Buffer.from(lastCmd().match(/echo '([^']+)'/)![1], "base64").toString();
  type Edit = { success: boolean; error?: string; added?: number; removed?: number };

  it("str_replace refuses an ambiguous old_str and tells the model how to proceed", async () => {
    execCommand.mockResolvedValue({ stdout: "MULTIPLE 3\n", stderr: "", exitCode: 1 });
    const { tools } = await load();
    const res = (await tools.str_replace.execute!({ path: "a.txt", old_str: "x", new_str: "y" }, opts)) as Edit;
    expect(res.success).toBe(false);
    expect(res.error).toContain("matches 3 places");
    expect(res.error).toContain("replace_all");
    expect(script()).toContain("replace_all = False");
  });

  it("str_replace with replace_all scales the line counts by the replacements made", async () => {
    execCommand.mockResolvedValue({ stdout: "OK 3 exact\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.str_replace.execute!(
      { path: "a.txt", old_str: "x\ny", new_str: "z", replace_all: true }, opts,
    )) as Edit;
    expect(script()).toContain("replace_all = True");
    expect(res).toEqual({ success: true, path: "a.txt", added: 3, removed: 6 }); // exact match: no note
  });

  it("str_replace tells the model when only a fallback tier matched", async () => {
    execCommand.mockResolvedValue({ stdout: "OK 1 typographic\n", stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.str_replace.execute!({ path: "a.txt", old_str: `"x"`, new_str: "y" }, opts)) as Edit & { note?: string };
    expect(res).toMatchObject({ success: true, added: 1, removed: 1 });
    expect(res.note).toContain("curly quotes");
  });

  it("str_replace keeps the not-found message", async () => {
    execCommand.mockResolvedValue({ stdout: "NOTFOUND\n", stderr: "", exitCode: 1 });
    const { tools } = await load();
    const res = (await tools.str_replace.execute!({ path: "a.txt", old_str: "x", new_str: "y" }, opts)) as Edit;
    expect(res.error).toBe("The old_str was not found in a.txt. It must match the file exactly, including whitespace and indentation.");
  });

  it("str_replace appends the miss hint, and parses the status from line one only", async () => {
    // A quoted file line that reads like a status must not flip the result.
    const hint = "The closest lines in the file:\n6: OK 1 exact";
    execCommand.mockResolvedValue({ stdout: `NOTFOUND\n${hint}\n`, stderr: "", exitCode: 0 });
    const { tools } = await load();
    const res = (await tools.str_replace.execute!({ path: "a.txt", old_str: "x", new_str: "y" }, opts)) as Edit;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found in a\.txt\.[^]*\n\nThe closest lines in the file:\n6: OK 1 exact$/);
  });

  it("str_replace reports a non-UTF-8 file and a no-op edit in plain words", async () => {
    const { tools } = await load();
    execCommand.mockResolvedValue({ stdout: "NOTUTF8\n", stderr: "", exitCode: 1 });
    const bad = (await tools.str_replace.execute!({ path: "a.txt", old_str: "x", new_str: "y" }, opts)) as Edit;
    expect(bad.error).toContain("not UTF-8");
    execCommand.mockResolvedValue({ stdout: "UNCHANGED\n", stderr: "", exitCode: 1 });
    const same = (await tools.str_replace.execute!({ path: "a.txt", old_str: "x", new_str: "y" }, opts)) as Edit;
    expect(same.error).toContain("unchanged");
  });

  it("str_replace writes nothing when old_str equals new_str", async () => {
    const { tools } = await load();
    const res = (await tools.str_replace.execute!({ path: "a.txt", old_str: "x", new_str: "x" }, opts)) as Edit;
    expect(res.success).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("search_files passes the pattern with -e and the path after --, so a leading '-' is not a flag", async () => {
    const { tools } = await load();
    await tools.search_files.execute!({ pattern: "-foo", path: "src" }, opts);
    expect(lastCmd()).toContain("rg --no-heading -n -e '-foo'");
    expect(lastCmd()).toContain("-- 'src'");
  });

  it("execute_bash defaults to a 120s timeout; file tools keep 30s; an explicit value still wins and is capped", async () => {
    const { tools } = await load();
    const timeoutOf = () => execCommand.mock.calls.at(-1)![2];
    await tools.execute_bash.execute!({ command: "true" }, opts);
    expect(timeoutOf()).toBe(120000);
    await tools.execute_python.execute!({ code: "1" }, opts);
    expect(timeoutOf()).toBe(120000);
    await tools.execute_node.execute!({ code: "1" }, opts);
    expect(timeoutOf()).toBe(120000);
    await tools.execute_bash.execute!({ command: "true", timeout: 999999 }, opts);
    expect(timeoutOf()).toBe(300000);
    await tools.read_file.execute!({ path: "a.txt" }, opts);
    expect(timeoutOf()).toBe(30000);
  });
});

describe("makeOrderGate", () => {
  it("runs writers alone in written order, lets reads share, and makes a read wait for the writes before it", async () => {
    const { makeOrderGate } = await import("@/lib/sandbox/tools");
    const gate = makeOrderGate();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}-`);
      return name;
    };
    const all = await Promise.all([
      gate.read(job("r1", 15)), gate.read(job("r2", 5)),   // together
      gate.write(job("w1", 15)),                            // after both reads
      gate.write(job("w2", 1)),                             // after w1 although faster
      gate.read(job("r3", 1)),                              // sees w2's result
    ]);
    expect(all).toEqual(["r1", "r2", "w1", "w2", "r3"]);
    expect(log).toEqual(["r1+", "r2+", "r2-", "r1-", "w1+", "w1-", "w2+", "w2-", "r3+", "r3-"]);
  });

  it("a failed call does not hold up the ones behind it", async () => {
    const { makeOrderGate } = await import("@/lib/sandbox/tools");
    const gate = makeOrderGate();
    const bad = gate.write(async () => { throw new Error("boom"); });
    const next = gate.write(async () => "ran");
    await expect(bad).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ran");
    await expect(gate.read(async () => "read")).resolves.toBe("read");
  });
});
