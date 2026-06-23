import { sanitizeBundlePath } from "@/lib/skills/paths";
import type { ServerDef } from "./manifest";

/** Placeholders the runtime resolves itself against a materialized plugin dir —
 *  NOT user secrets. `${CLAUDE_PLUGIN_DATA}` is a writable subdir of the root. */
const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";
const PLUGIN_DATA = "${CLAUDE_PLUGIN_DATA}";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/** Where a plugin's bundled files are materialized inside the sandbox. */
export function pluginBaseDir(installId: string): string {
  if (!SAFE_ID.test(installId)) throw new Error(`Unsafe install id: ${installId}`);
  return `/plugins/${installId}`;
}

/** Does any part reference the plugin root/data — i.e. the server bundles files
 *  that must be materialized into the sandbox before it can run? */
export function refsPluginRoot(parts: (string | undefined)[]): boolean {
  return parts.some((s) => typeof s === "string" && (s.includes(PLUGIN_ROOT) || s.includes(PLUGIN_DATA)));
}

/** After dropping runtime-resolvable placeholders, does a real `${...}` remain
 *  (a secret / user-config the operator must fill in)? */
export function hasUnresolvedPlaceholder(s: string): boolean {
  const stripped = s.split(PLUGIN_ROOT).join("").split(PLUGIN_DATA).join("");
  return /\$\{[^}]+\}/.test(stripped);
}

/** Substitute plugin placeholders across a stdio server spec (command/args/env). */
export function substituteServerSpec(
  spec: { command: string; args?: string[]; env?: Record<string, string> },
  baseDir: string,
): { command: string; args?: string[]; env?: Record<string, string> } {
  const sub = (s: string) => s.split(PLUGIN_ROOT).join(baseDir).split(PLUGIN_DATA).join(`${baseDir}/.data`);
  return {
    command: sub(spec.command),
    ...(spec.args ? { args: spec.args.map(sub) } : {}),
    ...(spec.env ? { env: Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, sub(v)])) } : {}),
  };
}

/** The string fields of a server def that may carry a plugin-root reference. */
export function serverDefParts(def: ServerDef): (string | undefined)[] {
  return [def.command, ...(def.args ?? []), ...(def.env ? Object.values(def.env) : [])];
}

interface TreeEntryLike { path: string; type: "blob" | "tree" }

/** Choose which plugin files to store for later materialization: blobs under the
 *  plugin root, excluding skills/ (stored separately as skillFiles), node_modules,
 *  and unsafe paths (zip-slip). Capped by file count; per-file/total byte caps are
 *  enforced by the caller while fetching content. */
export function selectPluginFiles(
  tree: TreeEntryLike[],
  prefix: string,
  opts: { maxFiles: number },
): string[] {
  const out: string[] = [];
  for (const t of tree) {
    if (t.type !== "blob") continue;
    if (!t.path.startsWith(prefix)) continue;
    const rel = t.path.slice(prefix.length);
    if (!rel || rel.startsWith("skills/") || rel.startsWith("node_modules/")) continue;
    if (!sanitizeBundlePath(rel)) continue;
    out.push(t.path);
    if (out.length >= opts.maxFiles) break;
  }
  return out;
}
