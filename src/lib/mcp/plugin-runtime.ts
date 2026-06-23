import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginFiles } from "@/lib/db/schema";
import { execCommand } from "@/lib/sandbox/client";
import { refsPluginRoot, serverDefParts, substituteServerSpec, pluginBaseDir } from "@/lib/marketplace/plugin-root";
import type { McpServerConfig } from "./types";

const CATALOG = "catalog:";

/** True for a stdio connector that came from a plugin install AND references the
 *  plugin root — its bundled files must be materialized into the sandbox and its
 *  ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_DATA} paths resolved before it can run. */
export function needsPluginRoot(cfg: McpServerConfig): boolean {
  return (
    cfg.transport === "stdio" &&
    !!cfg.source?.startsWith(CATALOG) &&
    refsPluginRoot(serverDefParts({ command: cfg.command, args: cfg.args, env: cfg.secrets?.env }))
  );
}

/** Materialize the plugin's bundled files into /plugins/<installId> in the session
 *  sandbox, then return a config with the plugin placeholders resolved against that
 *  dir. Idempotent per session (re-writing the same files is harmless). */
export async function resolvePluginRoot(sessionKey: string, cfg: McpServerConfig): Promise<McpServerConfig> {
  const installId = cfg.source!.slice(CATALOG.length);
  const baseDir = pluginBaseDir(installId); // throws on an unsafe id
  const files = await db
    .select({ path: pluginFiles.path, content: pluginFiles.content })
    .from(pluginFiles)
    .where(eq(pluginFiles.installId, installId));
  await materialize(sessionKey, baseDir, files);

  const spec = substituteServerSpec({ command: cfg.command!, args: cfg.args, env: cfg.secrets?.env }, baseDir);
  // A bundled entrypoint decoded from base64 isn't executable; if the command is a
  // path inside the plugin dir, make it runnable (no-op for `node x.js` style).
  if (spec.command.startsWith(`${baseDir}/`)) {
    await execCommand(sessionKey, `chmod +x '${shellQuote(spec.command)}'`, 10_000).catch(() => {});
  }
  return { ...cfg, command: spec.command, args: spec.args, secrets: { ...cfg.secrets, env: spec.env } };
}

const shellQuote = (s: string) => s.replace(/'/g, "'\\''");

// Bound each exec body so a fat plugin doesn't send one enormous command; far
// fewer round-trips than one-exec-per-file (the old behavior) at scale.
const MATERIALIZE_BATCH_BYTES = 512_000;

/** Write base64 file contents into the sandbox, batching writes to cut sandbox
 *  round-trips. Paths were sanitized at install time; content is pure base64. */
async function materialize(sessionKey: string, baseDir: string, files: { path: string; content: string }[]): Promise<void> {
  let batch: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    // Newline-joined: each file's mkdir+decode runs sequentially in one shell.
    await execCommand(sessionKey, batch.join("\n"), 30_000);
    batch = [];
    bytes = 0;
  };
  for (const f of files) {
    const abs = shellQuote(`${baseDir}/${f.path}`);
    const line = `mkdir -p "$(dirname '${abs}')" && printf %s '${f.content}' | base64 -d > '${abs}'`;
    if (bytes && bytes + line.length > MATERIALIZE_BATCH_BYTES) await flush();
    batch.push(line);
    bytes += line.length + 1;
  }
  await flush();
}
