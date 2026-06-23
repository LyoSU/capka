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

/** Write base64 file contents into the sandbox, one file per exec (mirrors the
 *  skill materializer). Paths were sanitized at install time. */
async function materialize(sessionKey: string, baseDir: string, files: { path: string; content: string }[]): Promise<void> {
  for (const f of files) {
    const abs = shellQuote(`${baseDir}/${f.path}`);
    await execCommand(sessionKey, `mkdir -p "$(dirname '${abs}')" && echo '${f.content}' | base64 -d > '${abs}'`, 15_000);
  }
}
