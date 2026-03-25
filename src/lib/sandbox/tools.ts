import { tool } from "ai";
import { z } from "zod";
import { createSession, execCommand } from "./client";

/**
 * Create sandbox tools for a chat session.
 * Modeled after Anthropic's Claude Code Execution tool set.
 *
 * NOTE: All commands run inside an isolated Docker container (not on the host).
 * Shell injection within the sandbox is by design — the container IS the security boundary.
 */
export async function loadSandboxTools(userId: string, chatId: string) {
  await createSession(chatId, userId);

  const run = (cmd: string, timeout?: number) =>
    execCommand(chatId, cmd, Math.min(timeout || 30000, 300000));

  const tools = {
    execute_bash: tool({
      description:
        "Execute a bash command in the sandbox. Available: Python 3.12, Node.js 22, Java 21, " +
        "FFmpeg, ImageMagick, Graphviz, Pandoc, LibreOffice (headless), LaTeX, Playwright+Chromium, " +
        "Tesseract OCR, ripgrep, git, curl, wget. Use for shell tasks, pipelines, system commands, " +
        "file management, package installation (pip/npm).",
      inputSchema: z.object({
        command: z.string().describe("Bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 30s, max 300s)"),
      }),
      execute: async ({ command, timeout }) => {
        const result = await run(command, timeout);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return { output: output || "(no output)", exitCode: result.exitCode, success: result.exitCode === 0 };
      },
    }),

    execute_python: tool({
      description:
        "Execute Python code in the sandbox. Available packages: numpy, pandas, scipy, scikit-learn, " +
        "matplotlib, seaborn, plotly, pillow, opencv, pypdf, pikepdf, pdfplumber, reportlab, " +
        "python-docx, python-pptx, openpyxl, xlsxwriter, requests, beautifulsoup4, flask, " +
        "playwright, sympy, networkx, camelot-py, tabula-py, pytesseract, yt-dlp, and 100+ more. " +
        "Use for data processing, file creation, analysis, scraping, ML tasks.",
      inputSchema: z.object({
        code: z.string().describe("Python code to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 30s, max 300s)"),
      }),
      execute: async ({ code, timeout }) => {
        // Base64 encode to avoid heredoc delimiter collisions and shell escaping issues
        const encoded = Buffer.from(code).toString("base64");
        const tmpFile = `/tmp/_exec_${Date.now()}.py`;
        const cmd = `echo '${encoded}' | base64 -d > ${tmpFile} && python3 ${tmpFile}; rc=$?; rm -f ${tmpFile}; exit $rc`;
        const result = await run(cmd, timeout);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return { output: output || "(no output)", exitCode: result.exitCode, success: result.exitCode === 0 };
      },
    }),

    execute_node: tool({
      description:
        "Execute Node.js/JavaScript code in the sandbox. Available packages: typescript, " +
        "docx, pptxgenjs, pdf-lib, sharp, marked, mermaid-cli, playwright, react. " +
        "Use for document generation, image processing, JS-specific tasks.",
      inputSchema: z.object({
        code: z.string().describe("JavaScript code to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 30s, max 300s)"),
      }),
      execute: async ({ code, timeout }) => {
        const encoded = Buffer.from(code).toString("base64");
        const tmpFile = `/tmp/_exec_${Date.now()}.mjs`;
        const cmd = `echo '${encoded}' | base64 -d > ${tmpFile} && node ${tmpFile}; rc=$?; rm -f ${tmpFile}; exit $rc`;
        const result = await run(cmd, timeout);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return { output: output || "(no output)", exitCode: result.exitCode, success: result.exitCode === 0 };
      },
    }),

    read_file: tool({
      description:
        "Read a file from the workspace. Returns file contents. Use for viewing code, configs, " +
        "logs, CSV data, or any text file. For binary files, use execute_bash with appropriate tools.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to /workspace"),
        max_lines: z.number().optional().describe("Max lines to return (default: all)"),
      }),
      execute: async ({ path, max_lines }) => {
        const safePath = path.replace(/'/g, "'\\''");
        const cmd = max_lines ? `head -n ${max_lines} '${safePath}'` : `cat '${safePath}'`;
        const result = await run(cmd);
        if (result.exitCode !== 0) return { error: result.stderr || "File not found", content: null };
        return { content: result.stdout, error: null };
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
        const cmd = `mkdir -p "$(dirname '${safePath}')" && cat > '${safePath}' << 'UNCLAW_EOF'\n${content}\nUNCLAW_EOF`;
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
        const cmd = `cat > /tmp/_replace.py << 'REPLEOF'\n${pyCode}\nREPLEOF\npython3 /tmp/_replace.py`;
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
        return { listing: result.stdout, error: result.exitCode !== 0 ? result.stderr : null };
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
        const result = await run(`rg --no-heading -n '${safePattern}' '${target}' ${globFlag} | head -100`);
        return { matches: result.stdout || "(no matches)", error: result.exitCode > 1 ? result.stderr : null };
      },
    }),
  };

  return { tools, close: async () => {} };
}
