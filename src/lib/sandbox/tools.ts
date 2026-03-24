import { tool } from "ai";
import { z } from "zod";
import { createSession, execCommand } from "./client";

/**
 * Create sandbox tools for a chat session.
 * Returns AI SDK tools + close function.
 */
export async function loadSandboxTools(userId: string, chatId: string) {
  // Ensure sandbox container exists
  await createSession(chatId, userId);

  const tools = {
    sandbox_exec: tool({
      description:
        "Execute a bash command in the user's sandbox. Use for running scripts, installing packages, compiling code, git operations, or any shell task. The sandbox has Python, Node.js, git, and common tools installed.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 30s, max 120s)"),
      }),
      execute: async ({ command, timeout }) => {
        const result = await execCommand(chatId, command, Math.min(timeout || 30000, 120000));
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return {
          output: output || "(no output)",
          exitCode: result.exitCode,
          success: result.exitCode === 0,
        };
      },
    }),

    sandbox_read_file: tool({
      description:
        "Read a file from the user's workspace. Returns the file contents. Use for viewing code, configs, logs, or any text file.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to /workspace"),
      }),
      execute: async ({ path }) => {
        const result = await execCommand(chatId, `cat '${path.replace(/'/g, "'\\''")}'`);
        if (result.exitCode !== 0) {
          return { error: result.stderr || "File not found", content: null };
        }
        return { content: result.stdout, error: null };
      },
    }),

    sandbox_write_file: tool({
      description:
        "Write content to a file in the user's workspace. Creates parent directories if needed. Use for creating scripts, configs, or any file.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to /workspace"),
        content: z.string().describe("File content to write"),
      }),
      execute: async ({ path, content }) => {
        // Create parent dirs + write file using heredoc to handle special chars
        const safePath = path.replace(/'/g, "'\\''");
        const cmd = `mkdir -p "$(dirname '${safePath}')" && cat > '${safePath}' << 'UNCLAW_EOF'\n${content}\nUNCLAW_EOF`;
        const result = await execCommand(chatId, cmd);
        if (result.exitCode !== 0) {
          return { error: result.stderr || "Write failed", success: false };
        }
        return { success: true, path };
      },
    }),

    sandbox_list: tool({
      description:
        "List files and directories in the user's workspace. Shows names, sizes, and types.",
      inputSchema: z.object({
        path: z.string().optional().describe("Directory path (default: /workspace)"),
      }),
      execute: async ({ path }) => {
        const target = path || ".";
        const safePath = target.replace(/'/g, "'\\''");
        const result = await execCommand(chatId, `ls -la '${safePath}'`);
        return { listing: result.stdout, error: result.exitCode !== 0 ? result.stderr : null };
      },
    }),

    sandbox_search: tool({
      description:
        "Search for text patterns in files. Uses ripgrep for fast regex search across the workspace.",
      inputSchema: z.object({
        pattern: z.string().describe("Search pattern (regex supported)"),
        path: z.string().optional().describe("Directory to search (default: /workspace)"),
        glob: z.string().optional().describe("File glob filter (e.g. '*.ts')"),
      }),
      execute: async ({ pattern, path, glob }) => {
        const safePattern = pattern.replace(/'/g, "'\\''");
        const target = path || ".";
        const globFlag = glob ? `--glob '${glob.replace(/'/g, "'\\''")}'` : "";
        const result = await execCommand(chatId, `rg --no-heading -n '${safePattern}' '${target}' ${globFlag} | head -100`);
        return {
          matches: result.stdout || "(no matches)",
          error: result.exitCode > 1 ? result.stderr : null,
        };
      },
    }),
  };

  return {
    tools,
    close: async () => {
      // Don't destroy — idle cleanup handles it
      // Container persists between messages in the same chat
    },
  };
}
