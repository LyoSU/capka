import { tool } from "ai";
import { z } from "zod";
import { execCommand, deleteFile } from "./client";
import { clampOutput, MAX_TOOL_OUTPUT_CHARS, DEFAULT_READ_LINES } from "@/lib/tool-output";

/** Recovery hint baked into the truncation marker so the model narrows next time.
 *  Steers toward grep / redirect-to-file rather than a blind `| head`/`| tail`,
 *  which silently drops the error lines before the model ever reads them. */
const NARROW_NOTE =
  "To get the rest, re-run narrowed: grep for the lines you need, or redirect to a file and page it with read_file(offset). Avoid a blind head/tail — it can hide the error.";

// ── Capture-to-file (tee-in-sandbox) ─────────────────────────────────────────
// Every command's FULL combined output is mirrored to a log file in the
// workspace, so the model can grep/read the rest instead of re-running. The
// inline view still streams back normally (and is clamped as before); the log is
// the recovery path. A byte cap bounds one runaway, and rotation bounds the dir.
const CAPTURE_DIR = "/workspace/.capka/output";
const CAPTURE_FILE_BYTES = (Number(process.env.OUTPUT_FILE_CAP_MB) || 10) * 1024 * 1024;
const CAPTURE_KEEP = Number(process.env.OUTPUT_KEEP_FILES) || 5;
/** RS-delimited trailer the wrapper prints on stderr: \x1e<bytes>\x1e<path|->.
 *  stderr is otherwise empty (the command's own stderr is merged into the log via
 *  2>&1), so this never collides with real output. */
const TRAILER = /\x1e(\d+)\x1e(.*?)\s*$/;

/** Wrap a command so its full output is tee'd to a rotated, size-capped log file.
 *  Built with real newlines (not `;`) so a `#` comment or trailing `;` in the
 *  user's command can't swallow the wrapper. The user command keeps its own exit
 *  code via PIPESTATUS + `exit`. */
function withCapture(inner: string): string {
  return `__d=${CAPTURE_DIR}
mkdir -p "$__d" 2>/dev/null
( cd "$__d" && ls -1t 2>/dev/null | tail -n +${CAPTURE_KEEP + 1} | xargs -r rm -f )
__f="$__d/$(date +%s%N)-$$.log"
{
${inner}
} 2>&1 | head -c ${CAPTURE_FILE_BYTES} | tee --output-error=warn "$__f"
__rc=\${PIPESTATUS[0]}
__sz=$(wc -c < "$__f" 2>/dev/null || echo 0)
if [ "$__sz" -le ${MAX_TOOL_OUTPUT_CHARS} ]; then rm -f "$__f"; __f=-; fi
printf '\\n\\036%s\\036%s\\n' "$__sz" "$__f" >&2
exit $__rc`;
}

const kbBytes = (n: number) => `${Math.round(n / 1024)} KB`;

// ── Background jobs ──────────────────────────────────────────────────────────
// A long command (bulk conversion, a big scrape) outlives the 300s exec cap by
// running detached: the "start" exec returns immediately, and the job keeps
// running because the container persists between turns. Output + exit code land
// in the workspace so a later check_job (or read_file) can recover them.
const JOBS_DIR = "/workspace/.capka/jobs";
const JOBS_KEEP = Number(process.env.JOBS_KEEP_DIRS) || 20;
/** Per-job stdout+stderr log ceiling. A runaway job that spews past this is
 *  truncated (and stops, via SIGPIPE) so it can't fill the workspace quota — the
 *  same protection the foreground tee-capture gives. Generous: real progress logs
 *  are tiny; JOBS_KEEP × this stays well under the 500 MB workspace cap. */
const JOB_LOG_CAP_BYTES = (Number(process.env.JOB_LOG_CAP_MB) || 10) * 1024 * 1024;

/** Launch `command` detached in its OWN session and return at once. The
 *  controller already runs our exec under `setsid … & wait`, so nesting another
 *  `setsid` fully detaches the job from that session — the controller's `wait`
 *  returns on our `echo`, its timeout-killer never fires, and the job (reparented
 *  to the container's PID 1) survives past this turn. The user command is base64'd
 *  so it's written verbatim; it stays UNQUOTED inside the single-quoted job script
 *  (the base64 alphabet has no shell metacharacters), which is why it can't break
 *  out of the surrounding quotes.
 *
 *  Rotation removes only FINISHED job dirs (those with an `exitcode`) so it can
 *  never delete a job that's still running. `$RC=$?` captures the user command's
 *  own exit (last in the pipeline = bash) before the log is written; the log is
 *  capped via `head -c`. */
function backgroundWrapper(command: string, jobId: string): string {
  const encoded = Buffer.from(command).toString("base64");
  const j = `${JOBS_DIR}/${jobId}`;
  return `mkdir -p '${j}'
( cd '${JOBS_DIR}' 2>/dev/null && for d in $(ls -1td */ 2>/dev/null); do [ -f "$d/exitcode" ] && printf '%s\\n' "$d"; done | tail -n +${JOBS_KEEP + 1} | xargs -r rm -rf )
setsid bash -c '{ echo ${encoded} | base64 -d | bash; RC=$?; echo $RC > "${j}/exitcode"; } 2>&1 | head -c ${JOB_LOG_CAP_BYTES} > "${j}/log"' </dev/null >/dev/null 2>&1 &
echo $! > '${j}/pid'
echo started`;
}

/**
 * Shape a captured exec result for the model with a THREE-state truncation signal:
 *  - "discarded": the controller hit its in-memory ceiling AND no log survived —
 *    the rest is gone, re-run producing less;
 *  - "clip": output was trimmed for the model but the FULL log is on disk —
 *    recoverable by reading/grepping `logPath` (no re-run needed);
 *  - "none": complete output, nothing kept.
 */
function captureResult(result: { stdout: string; stderr: string; exitCode: number; truncated?: boolean }) {
  const m = result.stderr.match(TRAILER);
  const sz = m ? parseInt(m[1], 10) : 0;
  const logPath = m && m[2] && m[2] !== "-" ? m[2] : null;
  const capped = logPath !== null && sz >= CAPTURE_FILE_BYTES;
  // Anything on stderr BEFORE the trailer is real (the command's stderr is merged
  // into the log via 2>&1, so this is normally empty — except the synthetic 413
  // quota message, which run() puts here and the model must see).
  const residualStderr = (m ? result.stderr.slice(0, m.index) : result.stderr).trim();

  // When a log survived, the recovery is "read the file", not "re-run".
  const note = logPath
    ? `Full output (${kbBytes(sz)}) is saved at ${logPath} — read or grep it (read_file/execute_bash) instead of re-running${capped ? `; that log was itself capped at ${CAPTURE_FILE_BYTES / 1024 / 1024} MB` : ""}.`
    : NARROW_NOTE;

  const clamped = clampOutput(result.stdout, { note });
  let output = [clamped.text, residualStderr && clampOutput(residualStderr).text].filter(Boolean).join("\n");
  let truncated: "none" | "clip" | "discarded" = clamped.clipped ? "clip" : "none";

  if (logPath) {
    truncated = "clip";
    // If the inline view fit (no marker) but a log was still kept, point at it.
    if (!clamped.clipped) output += `\n[… Capka: ${note}]`;
  } else if (result.truncated) {
    truncated = "discarded";
    output +=
      "\n\n[… Capka: output exceeded the sandbox limit and was stopped at the source — the rest was DISCARDED and cannot be read. Re-run the command so it produces less output (filter, or redirect to a file).]";
  }

  return {
    output: output || "(no output)",
    exitCode: result.exitCode,
    success: result.exitCode === 0,
    truncated,
    ...(logPath ? { logPath } : {}),
  };
}

/**
 * Create sandbox tools for a chat session.
 * Modeled after Anthropic's Claude Code Execution tool set.
 *
 * NOTE: All commands run inside an isolated Docker container (not on the host).
 * Shell injection within the sandbox is by design — the container IS the security boundary.
 *
 * `ensureSession` is the run's shared, memoized session creator: the container is
 * spun up on the FIRST tool call (lazy) and shared with the MCP/skill paths.
 */
export async function loadSandboxTools(sessionKey: string, userId: string, ensureSession: () => Promise<unknown>) {
  const run = async (cmd: string, timeout?: number) => {
    await ensureSession();
    try {
      return await execCommand(sessionKey, cmd, Math.min(timeout || 30000, 300000));
    } catch (e) {
      // The disk-quota block (HTTP 413) is the one exec failure the agent can fix
      // on its own — by freeing space with delete_path. Surface it as a normal
      // failed command result (the actionable message in stderr) so the model
      // reads it and recovers, rather than the tool call hard-erroring.
      if (e && typeof e === "object" && (e as { status?: number }).status === 413) {
        return { stdout: "", stderr: (e as Error).message, exitCode: 1 };
      }
      throw e;
    }
  };

  const tools = {
    execute_bash: tool({
      description:
        "Run a bash command in the Linux sandbox — shell tasks, pipelines, file management, " +
        "running command-line tools, and installing packages (pip/npm). Common runtimes and CLI " +
        "tools are preinstalled. No network by default. " +
        "Set background:true for work that won't finish inside the 300s limit (bulk conversion, a " +
        "long scrape): it starts the command detached and returns a jobId immediately — the job " +
        "keeps running after your reply. Check it later with check_job.",
      inputSchema: z.object({
        command: z.string().describe("Bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 30s, max 300s)"),
        background: z
          .boolean()
          .optional()
          .describe("Run detached and return a jobId at once, for commands longer than 300s"),
      }),
      execute: async ({ command, timeout, background }) => {
        if (background) {
          const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const result = await run(backgroundWrapper(command, jobId));
          if (result.exitCode !== 0) return { started: false, error: result.stderr || "Failed to start job" };
          return {
            started: true,
            jobId,
            logPath: `${JOBS_DIR}/${jobId}/log`,
            note:
              "Job started and keeps running after your reply ends (the sandbox persists between turns). " +
              "Get the result with check_job when you next need it — don't block waiting. " +
              "Note: if the chat sits idle ~15 min with no sandbox activity the container is reclaimed and the " +
              "job stops; its log and exit code (if written) survive. For a job that may run that long, keep the " +
              "chat active or check back within that window.",
          };
        }
        return captureResult(await run(withCapture(command), timeout));
      },
    }),

    check_job: tool({
      description:
        "Check a background job started by execute_bash(background:true). Returns whether it's still " +
        "running, its exit code once finished, and the tail of its output log.",
      inputSchema: z.object({
        jobId: z.string().describe("The jobId returned by execute_bash(background:true)"),
      }),
      execute: async ({ jobId }) => {
        const j = `${JOBS_DIR}/${jobId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
        // One round-trip: exit code (source of truth for "finished"), then pid
        // liveness (distinguishes still-running from killed-without-recording, e.g.
        // a container restart), then a bounded tail of the merged output log.
        const cmd = `__j='${j}'
if [ ! -d "$__j" ]; then echo __NOJOB__; exit 0; fi
if [ -f "$__j/exitcode" ]; then echo "__EXIT__$(cat "$__j/exitcode")"
elif [ -f "$__j/pid" ] && kill -0 "$(cat "$__j/pid")" 2>/dev/null; then echo __RUNNING__
else echo __DEAD__; fi
echo __LOG__
tail -c 4000 "$__j/log" 2>/dev/null || true`;
        const result = await run(cmd);
        const out = result.stdout;
        // Split the status record from the log BEFORE parsing: the log tail is
        // arbitrary job output and could itself contain "__EXIT__0"/"__RUNNING__",
        // which would spoof the status if we matched over the whole stdout.
        const logIdx = out.indexOf("__LOG__");
        const statusPart = logIdx >= 0 ? out.slice(0, logIdx) : out;
        const logTail = logIdx >= 0 ? out.slice(logIdx + "__LOG__".length).replace(/^\n/, "") : "";
        if (statusPart.includes("__NOJOB__")) {
          return { error: `No job ${jobId} — it may have been rotated out. Its output, if any, is under ${JOBS_DIR}.` };
        }
        const exitMatch = statusPart.match(/__EXIT__(-?\d+)/);
        if (exitMatch) {
          const exitCode = parseInt(exitMatch[1], 10);
          return { running: false, exitCode, success: exitCode === 0, logTail: clampOutput(logTail).text };
        }
        if (statusPart.includes("__RUNNING__")) {
          return { running: true, logTail: clampOutput(logTail).text };
        }
        return {
          running: false,
          exitCode: null,
          note: "The job process is gone but never recorded an exit code — it was likely killed (e.g. a sandbox restart). The log below is whatever it wrote before stopping.",
          logTail: clampOutput(logTail).text,
        };
      },
    }),

    execute_python: tool({
      description:
        "Run Python code in the sandbox — data processing, file creation, analysis, automation. " +
        "Common scientific, document, image, PDF, and web libraries are preinstalled; install " +
        "anything else with pip if needed.",
      inputSchema: z.object({
        code: z.string().describe("Python code to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 30s, max 300s)"),
      }),
      execute: async ({ code, timeout }) => {
        // Pipe the program straight into the interpreter's stdin instead of staging
        // it in /tmp. The sandbox's /tmp is a small (64 MB) tmpfs shared by every
        // process; a sibling that fills it must never break code execution or file
        // editing. Base64 still guards against shell-escaping/delimiter collisions.
        const encoded = Buffer.from(code).toString("base64");
        const cmd = `echo '${encoded}' | base64 -d | python3 -`;
        return captureResult(await run(withCapture(cmd), timeout));
      },
    }),

    execute_node: tool({
      description:
        "Run Node.js / JavaScript code in the sandbox — document generation, image processing, " +
        "and other JS tasks. Common libraries are preinstalled; install anything else with npm if needed.",
      inputSchema: z.object({
        code: z.string().describe("JavaScript code to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 30s, max 300s)"),
      }),
      execute: async ({ code, timeout }) => {
        // Pipe through node's stdin (ESM, matching the previous .mjs staging) so
        // execution never depends on writable /tmp. See execute_python above.
        const encoded = Buffer.from(code).toString("base64");
        const cmd = `echo '${encoded}' | base64 -d | node --input-type=module`;
        return captureResult(await run(withCapture(cmd), timeout));
      },
    }),

    read_file: tool({
      description:
        "Read a file from the workspace. Returns file contents. Use for viewing code, configs, " +
        "logs, CSV data, or any text file. Reads a bounded window: up to ~" +
        `${DEFAULT_READ_LINES} lines by default — read only what you need, and page through a big ` +
        "file with `offset` rather than pulling it all at once. For binary files, use execute_bash.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to /workspace"),
        max_lines: z.number().optional().describe(`Max lines to return (default: ${DEFAULT_READ_LINES})`),
        offset: z.number().optional().describe("1-based line to start from (default: 1) — use to page through a large file"),
      }),
      execute: async ({ path, max_lines, offset }) => {
        const safePath = path.replace(/'/g, "'\\''");
        const start = Math.max(1, offset ?? 1);
        const count = Math.max(1, max_lines ?? DEFAULT_READ_LINES);
        // Print [start .. start+count] — one sentinel line past the window so we can
        // tell whether more follows — then quit so a huge file isn't read to the end.
        // sed (not `tail|head`) keeps the exit code reflecting a missing file and
        // sidesteps the head-closes-the-pipe SIGPIPE trap.
        const last = start + count;
        const result = await run(`sed -n '${start},${last}p;${last}q' '${safePath}'`);
        if (result.exitCode !== 0) return { error: result.stderr || "File not found", content: null };
        // A NUL byte means this is binary, not text. Returning the raw bytes
        // would (a) feed the model useless mojibake that bloats context and
        // invites byte-level hallucination, and (b) carry a NUL that Postgres
        // rejects on persist (the runner's stripNul is the safety net for that).
        // Report it instead — as the tool's own description already advises.
        if (result.stdout.includes("\u0000")) {
          const sz = await run(`wc -c < '${safePath}'`);
          const bytes = sz.exitCode === 0 ? sz.stdout.trim() : "unknown";
          return {
            error: `Binary file (${bytes} bytes) — not text. Inspect it with execute_bash (e.g. \`file\`, \`xxd\`) or process it in execute_python.`,
            content: null,
          };
        }
        // We asked for one line past the window; if it arrived, more of the file
        // follows and we tell the model exactly where to resume.
        const body = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
        const lines = body === "" ? [] : body.split("\n");
        const more = lines.length > count;
        const shown = more ? lines.slice(0, count).join("\n") : result.stdout;
        // Char-only guard for a window of very long lines (the line budget is already met).
        const guard = clampOutput(shown, { mode: "head", maxLines: count + 1 });
        if (!more && !guard.clipped) return { content: guard.text, error: null };
        const note = more
          ? `\n[… Capka: showing lines ${start}–${start + count - 1} — more follows. Read the next page: read_file(path, offset=${start + count}). Display limit, not the end of the file.]`
          : "";
        return { content: guard.text + note, error: null, truncated: true };
      },
    }),

    write_file: tool({
      description:
        "Write content to a file in the workspace. Creates parent directories automatically. " +
        "Use for creating scripts, configs, data files, HTML, or any text content.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to /workspace"),
        content: z.string().describe("File content"),
      }),
      execute: async ({ path, content }) => {
        const safePath = path.replace(/'/g, "'\\''");
        // Base64 the payload so an arbitrary content (including a line equal to a
        // heredoc delimiter) is written verbatim, never truncated.
        const encoded = Buffer.from(content).toString("base64");
        const cmd = `mkdir -p "$(dirname '${safePath}')" && echo '${encoded}' | base64 -d > '${safePath}'`;
        const result = await run(cmd);
        if (result.exitCode !== 0) return { error: result.stderr || "Write failed", success: false };
        return { success: true, path };
      },
    }),

    str_replace: tool({
      description:
        "Replace text in an existing file. Use for iterative edits — change a specific part " +
        "of a file without rewriting the whole thing.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to /workspace"),
        old_str: z.string().describe("Exact text to find (must match exactly)"),
        new_str: z.string().describe("Text to replace it with"),
      }),
      execute: async ({ path, old_str, new_str }) => {
        const pyCode = `import sys
p = ${JSON.stringify(path)}
old = ${JSON.stringify(old_str)}
new = ${JSON.stringify(new_str)}
with open(p) as f: content = f.read()
if old not in content: print('ERROR: text not found'); sys.exit(1)
with open(p, 'w') as f: f.write(content.replace(old, new, 1))
print('OK')`;
        // Base64 + pipe to python3's stdin: verbatim script, no heredoc/escaping
        // surprises, and — crucially — no /tmp write, so editing a file in
        // /workspace survives even when the tmpfs /tmp is full. The path/old/new
        // are baked into the script, so it needs no stdin of its own.
        const encoded = Buffer.from(pyCode).toString("base64");
        const cmd = `echo '${encoded}' | base64 -d | python3 -`;
        const result = await run(cmd);
        if (result.exitCode !== 0) return { error: result.stdout + result.stderr, success: false };
        return { success: true, path };
      },
    }),

    list_files: tool({
      description: "List files and directories in the workspace.",
      inputSchema: z.object({
        path: z.string().optional().describe("Directory path (default: /workspace)"),
      }),
      execute: async ({ path }) => {
        const target = (path || ".").replace(/'/g, "'\\''");
        const result = await run(`ls -la '${target}'`);
        const clamped = clampOutput(result.stdout, {
          mode: "head",
          note: "Narrow it: pass a subdirectory, or use search_files by name.",
        });
        return { listing: clamped.text, error: result.exitCode !== 0 ? result.stderr : null, truncated: clamped.clipped };
      },
    }),

    delete_path: tool({
      description:
        "Delete a file or an entire folder (recursively) from the workspace. Use this to remove " +
        "files you no longer need, and especially to FREE SPACE when the workspace is full — it is " +
        "the only way to delete then, because `rm` via execute_bash is paused while storage is over " +
        "the limit. Deletion is permanent.",
      inputSchema: z.object({
        path: z.string().describe("Path relative to /workspace — a file or a folder"),
      }),
      execute: async ({ path }) => {
        await ensureSession();
        try {
          await deleteFile(sessionKey, path, userId);
          return { success: true, path };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : "Delete failed" };
        }
      },
    }),

    search_files: tool({
      description: "Search for text patterns in files using ripgrep. Fast regex search across the workspace.",
      inputSchema: z.object({
        pattern: z.string().describe("Search pattern (regex)"),
        path: z.string().optional().describe("Directory to search (default: /workspace)"),
        glob: z.string().optional().describe("File glob filter (e.g. '*.py')"),
      }),
      execute: async ({ pattern, path, glob }) => {
        const safePattern = pattern.replace(/'/g, "'\\''");
        const target = (path || ".").replace(/'/g, "'\\''");
        const globFlag = glob ? `--glob '${glob.replace(/'/g, "'\\''")}'` : "";
        // One past the cap so we can tell the model whether matches were hidden —
        // a silent `| head -100` makes it believe there are exactly ≤100 matches.
        const result = await run(`rg --no-heading -n '${safePattern}' '${target}' ${globFlag} | head -101`);
        const body = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
        const all = body === "" ? [] : body.split("\n");
        const capped = all.length > 100;
        const matches = (capped ? all.slice(0, 100) : all).join("\n") || "(no matches)";
        const note = capped
          ? "\n[… Capka: showing the first 100 matches — more exist. Narrow the pattern, path, or glob.]"
          : "";
        return { matches: matches + note, error: result.exitCode > 1 ? result.stderr : null, truncated: capped };
      },
    }),
  };

  return { tools, close: async () => {} };
}
