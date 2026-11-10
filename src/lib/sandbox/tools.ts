import { tool } from "ai";
import { z } from "zod";
import { execCommand, deleteFile, deleteSharedFile, markBusy } from "./client";
import { clampOutput, MAX_TOOL_OUTPUT_CHARS, DEFAULT_READ_LINES } from "@/lib/tool-output";
import { nonNegInt, posInt } from "@/lib/config/env";
import { lineCount } from "@/lib/chat/edit-stats";
import { redactSecrets, loadRedactionSecrets } from "@/lib/chat/secrets";

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
const CAPTURE_FILE_BYTES = posInt(process.env.OUTPUT_FILE_CAP_MB, 10) * 1024 * 1024;
const CAPTURE_KEEP = nonNegInt(process.env.OUTPUT_KEEP_FILES, 5);
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
const JOBS_KEEP = nonNegInt(process.env.JOBS_KEEP_DIRS, 20);
/** Per-job stdout+stderr log ceiling. A runaway job that spews past this is
 *  truncated (and stops, via SIGPIPE) so it can't fill the workspace quota — the
 *  same protection the foreground tee-capture gives. Generous: real progress logs
 *  are tiny; JOBS_KEEP × this stays well under the 500 MB workspace cap. */
const JOB_LOG_CAP_BYTES = posInt(process.env.JOB_LOG_CAP_MB, 10) * 1024 * 1024;

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

/** The file-access tools shell out to sed/ls/rg/python, and their raw stderr
 *  (`sed: can't read /workspace/x: No such file or directory`) renders verbatim
 *  in the chat card — jargon a non-technical user should never see. Rewrite the
 *  known OS phrases into a calm, path-first sentence; pass anything else through
 *  unchanged so an actionable message (notably the over-quota WORKSPACE_FULL text
 *  that `run` surfaces on HTTP 413) is never swallowed. */
function friendlyFsError(stderr: string, path: string): string {
  const e = (stderr || "").toLowerCase();
  if (/no such file|not found/.test(e)) return `File not found: ${path}`;
  if (/is a directory/.test(e)) return `${path} is a folder, not a file.`;
  if (/permission denied/.test(e)) return `Permission denied: ${path}`;
  return (stderr || "").trim() || `Could not access ${path}.`;
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
export async function loadSandboxTools(
  sessionKey: string,
  userId: string,
  ensureSession: () => Promise<unknown>,
  networkMode: "none" | "bridge" = "none",
  /** Called when the controller reports the container is gone. The run's
   *  `ensureSession` is memoized, so without dropping that memo every remaining
   *  command in the turn fails identically against a sandbox nobody will rebuild. */
  onSandboxGone?: () => void,
  /** The chat's stored credentials, resolved lazily on the first command of the turn.
   *  Absent for a run with no chat (and for every caller that predates the feature),
   *  in which case nothing is injected and nothing is redacted. */
  secrets?: () => Promise<Record<string, string>>,
  /** Records a started background job so the platform watches it and tells the agent
   *  when it ends (src/lib/tasks/background-jobs.ts). Resolves to whether that notice
   *  will arrive; absent or rejected means it won't, and the result says check_job. */
  onBackgroundStart?: (job: { jobId: string; command: string }) => Promise<boolean>,
) {
  // ONE resolution per turn, memoized on the promise rather than the value: two tools
  // running concurrently must not each decrypt the same rows, and the very common
  // case (a chat with no secrets) must not pay a query per command.
  let secretEnv: Promise<Record<string, string>> | null = null;
  const resolveSecrets = (): Promise<Record<string, string>> => {
    if (!secrets) return Promise.resolve({});
    // A failure here is not a failed command: the turn continues without the
    // variables, and whatever needed them fails on its own with a readable error.
    secretEnv ??= secrets().catch((e) => {
      console.warn("[sandbox] chat secrets unavailable:", e instanceof Error ? e.message : e);
      return {};
    });
    return secretEnv;
  };
  // What gets INJECTED is this chat's own env, above. What gets REDACTED is wider: the
  // workspace is shared by every chat in the project (`projectId ?? chatId`), so a
  // background job's raw log under `/workspace/.capka/jobs/` can hold a sibling chat's
  // credential and this turn would have handed the model the plaintext. Same memoization,
  // and resolved only for a run that has a chat at all — a caller with no `secrets` thunk
  // has no session-scoped credentials to look up.
  //
  // FAIL CLOSED. This used to degrade to this chat's own values on a failed query, which
  // read as a safe fallback and was not one: the values "already in hand" are exactly the
  // ones this chat's env carries, and the whole reason the union exists is the values that
  // are NOT — a sibling chat's credential sitting in a shared job log. So a database
  // hiccup turned the leak back on, silently, for the one case the union was added for.
  // The failure is not memoized either: a later command in the same turn retries rather
  // than inheriting one bad moment for the rest of the run.
  let redactPairs: Promise<[string, string][]> | null = null;
  const resolveRedaction = (): Promise<[string, string][]> => {
    if (!secrets) return Promise.resolve([]);
    redactPairs ??= loadRedactionSecrets(sessionKey, userId).catch((e) => {
      redactPairs = null;
      console.warn("[sandbox] workspace secrets unavailable for redaction:", e instanceof Error ? e.message : e);
      // Calm and relayable: the model can say this and try again, which is the whole
      // recovery. It must NOT read as the command having failed on its own terms.
      throw new Error("Workspace secrets could not be loaded, so this command was not run — try again.");
    });
    return redactPairs;
  };
  // Best-effort lease: a job that outlives the turn keeps the container alive only
  // while the controller knows it's there. A failed lease is not a failed job — it
  // just falls back to plain idle eviction — so this never rejects into a tool call.
  const holdSandbox = () =>
    markBusy(sessionKey).catch((e) => {
      console.warn("[sandbox] busy lease failed:", e instanceof Error ? e.message : e);
    });

  // `signal` is the turn's abort signal, which the AI SDK hands to every tool
  // execution. Passing it on is what makes a cancelled turn stop the work inside
  // the container instead of only on screen: the controller kills the command's
  // process group when this request's connection goes away. A detached background
  // job is deliberately NOT given it — it is meant to outlive the turn.
  const run = async (cmd: string, timeout?: number, signal?: AbortSignal, defaultTimeout = 30000) => {
    await ensureSession();
    // Injected on EVERY command and redacted out of EVERY result, in this one
    // function — which is what makes the guarantee hold for tools nobody thought
    // about while writing this: bash, python, read_file, grep, the background-job
    // start and its log tail all go through here, so none of them can leak a value
    // by forgetting to opt in. The tee'd capture log inside the workspace keeps the
    // raw bytes — it is the user's own container, not the transcript — and the model
    // can only reach it by reading the file, which is another trip through here.
    // Rejects when the workspace union could not be read, and that rejection is the
    // point: the command has not run yet, so refusing here is what makes "no output
    // leaves this function unredacted" true even when the database is unreachable.
    const [env, workspaceSecrets] = await Promise.all([resolveSecrets(), resolveRedaction()]);
    // This chat's own values first — the union already contains them, and listing them
    // ahead keeps the injected set covered whatever order the query returns.
    const toRedact: [string, string][] = [...Object.entries(env), ...workspaceSecrets];
    try {
      const result = await execCommand(sessionKey, cmd, Math.min(timeout || defaultTimeout, 300000), signal, env);
      return {
        ...result,
        stdout: redactSecrets(result.stdout, toRedact),
        stderr: redactSecrets(result.stderr, toRedact),
      };
    } catch (e) {
      // The disk-quota block (HTTP 413) is the one exec failure the agent can fix
      // on its own — by freeing space with delete_path. Surface it as a normal
      // failed command result (the actionable message in stderr) so the model
      // reads it and recovers, rather than the tool call hard-erroring.
      if (e && typeof e === "object" && (e as { status?: number }).status === 413) {
        return { stdout: "", stderr: (e as Error).message, exitCode: 1 };
      }
      // The sandbox died under the command (409). Drop the memoized session so the
      // NEXT call builds a fresh container, and hand the model the controller's
      // message — which says what survived — as a failed command rather than a hard
      // tool error. Deliberately NOT an automatic re-run of `cmd`: /workspace is a
      // bind-mount that outlived the container, so a non-idempotent command may
      // already be half-applied, and repeating it silently is the worse failure.
      if (e && typeof e === "object" && (e as { status?: number }).status === 409) {
        onSandboxGone?.();
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
        "tools are preinstalled. " +
        (networkMode === "bridge"
          // Deliberately not a promise of open access: a deployment may run a host
          // allowlist, in which case anything off it fails as a proxy refusal.
          ? "Network access is available, though this deployment may allow only certain hosts. "
          : "No network access — package installs and internet requests will fail. ") +
        "Set background:true for work that won't finish inside the 300s limit (bulk conversion, a " +
        "long scrape): it starts the command detached and returns a jobId immediately — the job " +
        "keeps running after your reply, and you are normally notified automatically when it ends " +
        "(the result says so). Never poll check_job in a loop or sleep waiting for it.",
      inputSchema: z.object({
        command: z.string().describe("Bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 120s, max 300s)"),
        background: z
          .boolean()
          .optional()
          .describe("Run detached and return a jobId at once, for commands longer than 300s"),
      }),
      execute: async ({ command, timeout, background }, { abortSignal }) => {
        if (background) {
          const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          // No abort signal on purpose: the job is detached and leased, so it
          // survives the turn by design — a cancel must not take it down with it.
          const result = await run(backgroundWrapper(command, jobId));
          if (result.exitCode !== 0) return { started: false, error: result.stderr || "Failed to start job" };
          await holdSandbox();
          const notified = onBackgroundStart
            ? await onBackgroundStart({ jobId, command }).catch((e) => {
                console.warn("[sandbox] background job not watched:", e instanceof Error ? e.message : e);
                return false;
              })
            : false;
          if (notified) {
            return {
              started: true,
              jobId,
              logPath: `${JOBS_DIR}/${jobId}/log`,
              note:
                "Job started. You will be notified automatically when it finishes — its exit status and the " +
                "end of its output arrive as a notice: during this reply if you are still working, otherwise " +
                "as a new turn after it. DO NOT poll check_job in a loop or sleep waiting for it. Keep doing " +
                "other useful work, or end your reply now and tell the user it is running and that you will " +
                "follow up. check_job is only for a deliberate one-off look at its progress.",
            };
          }
          return {
            started: true,
            jobId,
            logPath: `${JOBS_DIR}/${jobId}/log`,
            note:
              "Job started and keeps running after your reply ends — the sandbox is held open for it even " +
              "while the chat sits idle. Get the result with check_job when you next need it; don't block " +
              "waiting. Each check extends the hold, so a job only loses its sandbox after several hours " +
              "with no check at all — its log and exit code (if written) survive that.",
          };
        }
        // 120s default (not the file tools' 30s): pip installs and document conversions
        // routinely run past 30s, and a timeout costs the model a failed call plus a retry.
        return captureResult(await run(withCapture(command), timeout, abortSignal, 120000));
      },
    }),

    check_job: tool({
      description:
        "Check a background job started by execute_bash(background:true). Returns whether it's still " +
        "running, its exit code once finished, and the tail of its output log. A one-off look — you " +
        "don't need it to learn that a job ended when its start result said you will be notified.",
      inputSchema: z.object({
        jobId: z.string().describe("The jobId returned by execute_bash(background:true)"),
      }),
      execute: async ({ jobId }, { abortSignal }) => {
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
        const result = await run(cmd, undefined, abortSignal);
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
          // Still working — renew the lease so the reaper keeps its hands off.
          await holdSandbox();
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
        "anything else with pip if needed. Every call is a fresh process: imports, variables and " +
        "loaded data do not carry over, so each call re-imports what it uses and re-reads its " +
        "inputs (save an intermediate result to a file if a later call needs it).",
      inputSchema: z.object({
        code: z.string().describe("Python code to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 120s, max 300s)"),
      }),
      execute: async ({ code, timeout }, { abortSignal }) => {
        // Pipe the program straight into the interpreter's stdin instead of staging
        // it in /tmp. The sandbox's /tmp is a small (64 MB) tmpfs shared by every
        // process; a sibling that fills it must never break code execution or file
        // editing. Base64 still guards against shell-escaping/delimiter collisions.
        const encoded = Buffer.from(code).toString("base64");
        const cmd = `echo '${encoded}' | base64 -d | python3 -`;
        return captureResult(await run(withCapture(cmd), timeout, abortSignal, 120000));
      },
    }),

    execute_node: tool({
      description:
        "Run Node.js / JavaScript code in the sandbox — document generation, image processing, " +
        "and other JS tasks. Common libraries are preinstalled; install anything else with npm if needed. " +
        "Every call is a fresh process: nothing defined in one call exists in the next.",
      inputSchema: z.object({
        code: z.string().describe("JavaScript code to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 120s, max 300s)"),
      }),
      execute: async ({ code, timeout }, { abortSignal }) => {
        // Pipe through node's stdin (ESM, matching the previous .mjs staging) so
        // execution never depends on writable /tmp. See execute_python above.
        const encoded = Buffer.from(code).toString("base64");
        const cmd = `echo '${encoded}' | base64 -d | node --input-type=module`;
        return captureResult(await run(withCapture(cmd), timeout, abortSignal, 120000));
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
      execute: async ({ path, max_lines, offset }, { abortSignal }) => {
        const safePath = path.replace(/'/g, "'\\''");
        const start = Math.max(1, offset ?? 1);
        const count = Math.max(1, max_lines ?? DEFAULT_READ_LINES);
        // Print [start .. start+count] — one sentinel line past the window so we can
        // tell whether more follows — then quit so a huge file isn't read to the end.
        // sed (not `tail|head`) keeps the exit code reflecting a missing file and
        // sidesteps the head-closes-the-pipe SIGPIPE trap.
        const last = start + count;
        const result = await run(`sed -n '${start},${last}p;${last}q' '${safePath}'`, undefined, abortSignal);
        if (result.exitCode !== 0) return { error: friendlyFsError(result.stderr, path), content: null };
        // A NUL byte means this is binary, not text. Returning the raw bytes
        // would (a) feed the model useless mojibake that bloats context and
        // invites byte-level hallucination, and (b) carry a NUL that Postgres
        // rejects on persist (the runner's stripNul is the safety net for that).
        // Report it instead — as the tool's own description already advises.
        if (result.stdout.includes("\u0000")) {
          const sz = await run(`wc -c < '${safePath}'`, undefined, abortSignal);
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
      execute: async ({ path, content }, { abortSignal }) => {
        const safePath = path.replace(/'/g, "'\\''");
        // Base64 the payload so an arbitrary content (including a line equal to a
        // heredoc delimiter) is written verbatim, never truncated.
        const encoded = Buffer.from(content).toString("base64");
        const cmd = `mkdir -p "$(dirname '${safePath}')" && echo '${encoded}' | base64 -d > '${safePath}'`;
        const result = await run(cmd, undefined, abortSignal);
        if (result.exitCode !== 0) return { error: result.stderr || "Write failed", success: false };
        // The size of the change, for the `+N` under the file's tile in the reply.
        return { success: true, path, lines: lineCount(content) };
      },
    }),

    str_replace: tool({
      description:
        "Replace text in an existing file. Use for iterative edits — change a specific part " +
        "of a file without rewriting the whole thing. old_str must match exactly one place in the " +
        "file, unless you pass replace_all:true to change every occurrence. Copy old_str exactly; " +
        "only if that finds nothing does it retry treating curly quotes, dashes and non-breaking " +
        "spaces as plain ones, then ignoring trailing spaces — and line endings (\\n vs CRLF) always follow the file.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to /workspace"),
        old_str: z
          .string()
          .describe("Exact text to find (must match exactly, and must occur only once unless replace_all is true)"),
        new_str: z.string().describe("Text to replace it with"),
        replace_all: z.boolean().optional().describe("Replace every occurrence of old_str instead of requiring a unique match"),
      }),
      execute: async ({ path, old_str, new_str, replace_all }, { abortSignal }) => {
        if (old_str === new_str) return { error: "old_str and new_str are identical — nothing to change.", success: false };
        if (old_str === "") return { error: "old_str is empty — give the text to replace.", success: false };
        // The script reports through a status on its FIRST line (OK n tier / NOTFOUND /
        // MULTIPLE n / UNCHANGED / NOTUTF8) that the TS side parses, so no behavior hangs
        // on matching prose. A NOTFOUND may be followed by a hint quoting the file; only
        // line one is ever parsed, so file text there cannot pass for a status.
        //
        // Matching is tiered because the files here are mostly people's prose, where the
        // model re-types curly quotes, en/em dashes and NBSPs as ASCII, and an exact
        // match then misses for nothing. So:
        // exact, then those look-alikes folded to ASCII, then whole lines ignoring trailing
        // whitespace. « » are deliberately NOT folded: a model reproduces them reliably, so
        // folding buys little, while a match it did make would swap a Ukrainian document's
        // «» for the ASCII quotes in new_str. A miss instead shows those lines in the
        // hint, whose comparison does fold them, since it only shows and never writes.
        //
        // String.raw so the Python escapes (\n, ‘) reach Python as written.
        const pyCode = String.raw`import sys, re, bisect, difflib
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
path = ${JSON.stringify(path)}
old = ${JSON.stringify(old_str)}
new = ${JSON.stringify(new_str)}
replace_all = ${replace_all ? "True" : "False"}

# One character to one character, so an offset found in norm(text) is the same
# offset in text, and the ORIGINAL span is what gets replaced.
TYPO = {}
for chars, plain in (
    ('‘’‚‛', "'"),
    ('“”„‟', '"'),
    ('‐‑‒–—―−', '-'),
    ('   　' + ''.join(map(chr, range(0x2002, 0x200b))), ' '),
):
    for c in chars: TYPO[ord(c)] = plain

def norm(s): return s.translate(TYPO)

def find(hay, needle):
    found, i = [], hay.find(needle)
    while i != -1:
        found.append((i, i + len(needle)))
        i = hay.find(needle, i + len(needle))
    return found

def find_lines(view, search):
    # Whole lines that agree once trailing whitespace is dropped; non-overlapping.
    trailing_nl = search.endswith('\n')
    want = search.split('\n')
    if trailing_nl: want.pop()
    want = [norm(l).rstrip() for l in want]
    lines, pos = [], 0
    for text in view.split('\n'):
        lines.append((pos, text, pos + len(text) < len(view)))
        pos += len(text) + 1
    if lines[-1][1] == '': lines.pop()  # the empty "line" after a final newline
    keys = [norm(text).rstrip() for _, text, _ in lines]
    found = []
    for i in range(len(lines) - len(want) + 1):
        if keys[i:i + len(want)] != want: continue
        last_start, last_text, has_nl = lines[i + len(want) - 1]
        if trailing_nl and not has_nl: continue
        if found and lines[i][0] < found[-1][1]: continue
        found.append((lines[i][0], last_start + len(last_text) + (1 if trailing_nl else 0)))
    return found

def ending(text):
    crlf = text.count('\r\n')
    lf = text.count('\n') - crlf
    return None if crlf == lf else '\r\n' if crlf > lf else '\n'

def with_region_endings(region, replacement, fallback):
    # A replacement line that keeps (or stands in for) a region line reuses that
    # line's ending, so context inside the match keeps its bytes even in a file
    # with mixed endings; only genuinely new lines take the fallback.
    before = region.split('\n')
    endings = ['\r\n' if l.endswith('\r') else '\n' for l in before[:-1]]
    after = replacement.split('\n')
    key = lambda l: norm(l.removesuffix('\r')).rstrip()
    source = {}
    sm = difflib.SequenceMatcher(None, [key(l) for l in before], [key(l) for l in after], autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ('equal', 'replace'):
            for k in range(min(i2 - i1, j2 - j1)): source[j1 + k] = i1 + k
    out = []
    for j, line in enumerate(after[:-1]):
        i = source.get(j)
        out.append(line + (endings[i] if i is not None and i < len(endings) else fallback))
    return ''.join(out) + after[-1]

def miss_hint(view, search, replacement):
    if len(replacement.strip()) >= 20 and norm(replacement) in norm(view):
        return 'new_str is already in the file, so this edit may already be applied.'
    # Each distinctive old_str line votes for where old_str would start, comparing
    # with all whitespace removed; at least half must agree. Only the span between
    # the first and last agreeing line is shown, so padding old_str reveals nothing.
    # « » fold here (only shown, never written), so "word" finds the «word» line.
    angle = str.maketrans('«»‹›', '""' + "''")
    key = lambda l: ''.join(norm(l).translate(angle).split())
    distinct = lambda k: any(c.isalnum() for c in k)
    lines, wanted = view.split('\n'), search.split('\n')
    positions, votes, distinct_count = {}, {}, 0
    for i, l in enumerate(lines):
        if distinct(key(l)): positions.setdefault(key(l), []).append(i)
    for off, l in enumerate(wanted):
        if not distinct(key(l)): continue
        distinct_count += 1
        for i in positions.get(key(l), []): votes[i - off] = votes.get(i - off, 0) + 1
    if not votes: return None
    start, count = max(votes.items(), key=lambda v: v[1])
    if count * 2 < distinct_count: return None
    matched = [start + off for off, l in enumerate(wanted)
               if key(l) and 0 <= start + off < len(lines) and key(lines[start + off]) == key(l)]
    first, to = matched[0], min(matched[-1] + 1, matched[0] + 12)
    shown = [f'{n + 1}: ' + (l[:200] + '…' if len(l) > 200 else l) for n, l in enumerate(lines[first:to], first)]
    return '\n'.join(['The closest lines in the file:'] + shown)

try:
    with open(path, encoding='utf-8', newline='') as f: source = f.read()
except UnicodeDecodeError:
    print('NOTUTF8'); sys.exit(1)

view = source.replace('\r\n', '\n')
search, replacement = old.replace('\r\n', '\n'), new.replace('\r\n', '\n')
if old.replace('\r', '') == new.replace('\r', ''):
    # Strings that differ only in \r ask to change line endings: exact bytes.
    tier, matches = 'exact', find(source, old)
    replace = lambda s, e: new
else:
    # Match on the LF view the model reads, then map offsets back to the source.
    tier, matches = 'exact', find(view, search)
    if not matches: tier, matches = 'typographic', find(norm(view), norm(search))
    if not matches: tier, matches = 'whitespace', find_lines(view, search)
    crs = [m.start() - k for k, m in enumerate(re.finditer('\r\n', source))]
    matches = [(s + bisect.bisect_left(crs, s), e + bisect.bisect_left(crs, e)) for s, e in matches]
    file_ending = ending(source) or '\n'
    replace = lambda s, e: with_region_endings(source[s:e], replacement, ending(source[s:e]) or file_ending)

if not matches:
    print('NOTFOUND')
    hint = miss_hint(view, search, replacement)
    if hint: print(hint)
    sys.exit(1)
if len(matches) > 1 and not replace_all: print('MULTIPLE', len(matches)); sys.exit(1)
out, last = [], 0
for s, e in (matches if replace_all else matches[:1]):
    out += [source[last:s], replace(s, e)]
    last = e
result = ''.join(out) + source[last:]
if result == source: print('UNCHANGED'); sys.exit(1)
with open(path, 'w', encoding='utf-8', newline='') as f: f.write(result)
print('OK', len(matches) if replace_all else 1, tier)`;
        // Base64 + pipe to python3's stdin: verbatim script, no heredoc/escaping
        // surprises, and — crucially — no /tmp write, so editing a file in
        // /workspace survives even when the tmpfs /tmp is full. The path/old/new
        // are baked into the script, so it needs no stdin of its own.
        const encoded = Buffer.from(pyCode).toString("base64");
        const cmd = `echo '${encoded}' | base64 -d | python3 -`;
        const result = await run(cmd, undefined, abortSignal);
        // Status is line one; the rest is the miss hint — file text, which reaches the
        // model only through `run`'s stdout and so is redacted like any other output.
        const [head, ...rest] = result.stdout.split("\n");
        const status = head.match(/^(OK|MULTIPLE|NOTFOUND|UNCHANGED|NOTUTF8)(?: (\d+))?(?: (exact|typographic|whitespace))?$/);
        if (result.exitCode === 0 && status?.[1] === "OK") {
          const count = Number(status[2]);
          // Lines replaced, as a diff would count them: the `+N −M` under the tile.
          const edit = { success: true, path, added: lineCount(new_str) * count, removed: lineCount(old_str) * count };
          // A fallback match means the file differs from what the model assumed; say so
          // once, so its next old_str copies the file's own characters.
          if (status[3] === "typographic")
            return { ...edit, note: "Matched only after treating the file's curly quotes, dashes or special spaces as plain ones; new_str was inserted exactly as written." };
          if (status[3] === "whitespace")
            return { ...edit, note: "Matched only after ignoring trailing spaces at the ends of lines." };
          return edit;
        }
        // The script's own status is the common failure; spell out what to do next.
        // Anything else is a shell/OS failure (missing file, etc.) — sanitize it like
        // the other file tools rather than leaking a Python traceback into the card.
        const hint = rest.join("\n").trimEnd();
        const error =
          status?.[1] === "NOTFOUND"
            ? `The old_str was not found in ${path}. It must match the file exactly, including whitespace and indentation.${hint ? `\n\n${hint}` : ""}`
            : status?.[1] === "MULTIPLE"
              ? `The old_str matches ${status[2]} places in ${path}. Include more surrounding text to make it unique, or pass replace_all:true to change every occurrence.`
              : status?.[1] === "UNCHANGED"
                ? `The edit leaves ${path} unchanged — it already contains that text.`
                : status?.[1] === "NOTUTF8"
                  ? `${path} is not UTF-8 text, so it can't be edited with str_replace. Use execute_python to edit it with the right encoding.`
                  : friendlyFsError(result.stderr, path);
        return { error, success: false };
      },
    }),

    list_files: tool({
      description:
        "List files and directories in the workspace (one directory level, with sizes and dates). To locate files by name, use execute_bash with `find`; search_files searches file contents.",
      inputSchema: z.object({
        path: z.string().optional().describe("Directory path (default: /workspace)"),
      }),
      execute: async ({ path }, { abortSignal }) => {
        const target = (path || ".").replace(/'/g, "'\\''");
        const result = await run(`ls -la '${target}'`, undefined, abortSignal);
        const clamped = clampOutput(result.stdout, {
          mode: "head",
          note: "Narrow it: pass a subdirectory, or use execute_bash with find.",
        });
        return {
          listing: clamped.text,
          error: result.exitCode !== 0 ? friendlyFsError(result.stderr, path || ".") : null,
          truncated: clamped.clipped,
        };
      },
    }),

    delete_path: tool({
      description:
        "Delete a file or an entire folder (recursively) from the workspace, or from the shared " +
        "folder by passing a /shared/… path. Use this to remove files you no longer need, and " +
        "especially to FREE SPACE when storage is full — it is the only way to delete then, because " +
        "`rm` via execute_bash is paused while storage is over the limit. Deletion is permanent.",
      inputSchema: z.object({
        path: z.string().describe("A file or folder in /workspace (relative or /workspace/…), or an absolute /shared/… path"),
      }),
      execute: async ({ path }) => {
        // A `/shared/…` path goes to the per-user shared store, which is a different
        // directory with its own quota — and the ONLY way to free it. Without this
        // branch the shared-full block named a tool that could not reach the files
        // it was telling the agent to delete: a stop with no exit.
        const shared = /^\/?shared(\/|$)/.test(path);
        await ensureSession();
        try {
          if (shared) {
            await deleteSharedFile(userId, path.replace(/^\/?shared\/?/, "") || ".");
          } else {
            // The model writes /workspace/… everywhere else, and the controller takes a
            // workspace-relative path: left absolute it read as a traversal and failed.
            await deleteFile(sessionKey, path.replace(/^\/workspace\/(?=.)/, ""), userId);
          }
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
      execute: async ({ pattern, path, glob }, { abortSignal }) => {
        const safePattern = pattern.replace(/'/g, "'\\''");
        const target = (path || ".").replace(/'/g, "'\\''");
        const globFlag = glob ? `--glob '${glob.replace(/'/g, "'\\''")}'` : "";
        // One past the cap so we can tell the model whether matches were hidden —
        // a silent `| head -100` makes it believe there are exactly ≤100 matches.
        const result = await run(`rg --no-heading -n -e '${safePattern}' ${globFlag} -- '${target}' | head -101`, undefined, abortSignal);
        const body = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
        const all = body === "" ? [] : body.split("\n");
        const capped = all.length > 100;
        const matches = (capped ? all.slice(0, 100) : all).join("\n") || "(no matches)";
        const note = capped
          ? "\n[… Capka: showing the first 100 matches — more exist. Narrow the pattern, path, or glob.]"
          : "";
        return {
          matches: matches + note,
          error: result.exitCode > 1 ? friendlyFsError(result.stderr, path || ".") : null,
          truncated: capped,
        };
      },
    }),
  };

  return { tools, close: async () => {} };
}
