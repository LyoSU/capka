import { tool } from "ai";
import { z } from "zod";
import { execCommand, deleteFile } from "./client";
import { clampOutput, DEFAULT_READ_LINES } from "@/lib/tool-output";

/** Recovery hint baked into the truncation marker so the model narrows next time.
 *  Steers toward grep / redirect-to-file rather than a blind `| head`/`| tail`,
 *  which silently drops the error lines before the model ever reads them. */
const NARROW_NOTE =
  "To get the rest, re-run narrowed: grep for the lines you need, or redirect to a file and page it with read_file(offset). Avoid a blind head/tail — it can hide the error.";

/**
 * Shape an exec result for the model with a THREE-state truncation signal:
 *  - "discarded": the controller hit its in-memory ceiling and threw the overflow
 *    away at the source — the rest is gone, the model must re-run producing less;
 *  - "clip": the full output existed but we trimmed it for the model — recoverable
 *    by narrowing/re-running;
 *  - "none": complete output.
 * stderr is kept (clamped on its own budget) because it usually holds the error —
 * it must never be the part that gets dropped when stdout is huge.
 */
function execResult(result: { stdout: string; stderr: string; exitCode: number; truncated?: boolean }) {
  const stdout = clampOutput(result.stdout, { note: NARROW_NOTE });
  const stderr = clampOutput(result.stderr);
  let output = [stdout.text, stderr.text].filter(Boolean).join("\n");
  let truncated: "none" | "clip" | "discarded" = stdout.clipped || stderr.clipped ? "clip" : "none";
  if (result.truncated) {
    truncated = "discarded";
    output +=
      "\n\n[… unClaw: output exceeded the sandbox limit and was stopped at the source — the rest was DISCARDED and cannot be read. Re-run the command so it produces less output (filter, or redirect to a file).]";
  }
  return { output: output || "(no output)", exitCode: result.exitCode, success: result.exitCode === 0, truncated };
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
export async function loadSandboxTools(sessionKey: string, ensureSession: () => Promise<unknown>) {
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
        "tools are preinstalled. No network by default.",
      inputSchema: z.object({
        command: z.string().describe("Bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 30s, max 300s)"),
      }),
      execute: async ({ command, timeout }) => execResult(await run(command, timeout)),
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
        return execResult(await run(cmd, timeout));
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
        return execResult(await run(cmd, timeout));
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
          ? `\n[… unClaw: showing lines ${start}–${start + count - 1} — more follows. Read the next page: read_file(path, offset=${start + count}). Display limit, not the end of the file.]`
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
          await deleteFile(sessionKey, path);
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
          ? "\n[… unClaw: showing the first 100 matches — more exist. Narrow the pattern, path, or glob.]"
          : "";
        return { matches: matches + note, error: result.exitCode > 1 ? result.stderr : null, truncated: capped };
      },
    }),
  };

  return { tools, close: async () => {} };
}
