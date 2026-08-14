import { ghFetch, ghRaw, ghTree, resolveCommit, type TreeEntry } from "./fetch";
import { extractServers, parseManifestMcp, type ServerDef } from "./manifest";
import { hasUnresolvedPlaceholder, refsPluginRoot, selectPluginFiles, serverDefParts } from "./plugin-root";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import type { CommitInfo, GitHubRef } from "./types";

/**
 * What an install WOULD do, resolved from a commit and nothing else.
 *
 * Deliberately free of writes and of probes: a plan for a fixed SHA is reproducible,
 * which is what lets a review be computed, shown, and then re-verified at apply time
 * (docs/plugin-install-review-spec.md §5). Anything reachable over the network lives
 * in `observePluginPlan` instead, however convenient it would be to fold in here.
 */

const IGNORED_DIRS = ["agents", "hooks", "lspServers", "outputStyles"];
const MAX_SKILL_FILES = 50;
// Caps on a plugin's bundled file tree (materialized into every user's sandbox),
// so a fat or hostile plugin can't bloat the DB or the sandbox.
const MAX_PLUGIN_FILES = 200;
const MAX_PLUGIN_FILE_BYTES = 1_000_000;
const MAX_PLUGIN_TOTAL_BYTES = 5_000_000;

/** One connector the install would create, described but not created. Carries no
 *  note: the note is derived from the same definition but belongs to `plan.notes`,
 *  whose ORDER is behaviour — duplicating it here would give two sources of truth. */
export interface PlannedConnector {
  name: string;
  /** Where this definition came from, `<manifest path>#<server key>`. Identity WITHIN
   *  one commit only: the server name IS the object key, so a rename changes it. */
  originKey: string;
  kind: "stdio" | "remote";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  bundled: boolean;
  envUnresolved: boolean;
  hasPlaceholder: boolean;
}

export interface PlannedSkill {
  name: string;
  /** Where the definition lives in the repo, relative to the plugin root —
   *  `skills/<dir>` or `commands/<file>.md`. Part of the surface: the same skill name
   *  arriving from a different path is a different resource. */
  originPath: string;
  /** The SKILL.md bytes as fetched, frontmatter included. Hashed for the surface, so it
   *  must be the RAW file: hashing `parsed.body` would miss a frontmatter edit, and
   *  frontmatter is where a skill's description and tool wiring live. */
  raw: string;
  parsed: ReturnType<typeof parseSkillMarkdown>;
  files: { path: string; content: string }[];
}

export interface ResolvedPluginPlan {
  commit: CommitInfo;
  version?: string;
  displayName?: string;
  connectors: PlannedConnector[];
  skills: PlannedSkill[];
  ignored: { type: string; count: number }[];
  /** Parse-derived notes in emission order: referenced-config failures, then root
   *  `.mcp.json` failures, then per-connector notes, then bundled-file caps. */
  notes: string[];
  files: { path: string; content: string }[];
  needsFiles: boolean;
}

export async function buildPluginPlan(gh: GitHubRef, only?: string[]): Promise<ResolvedPluginPlan> {
  // `only` (from `--skill`) narrows the install to specific skills by name. A
  // skill-scoped install ignores connectors entirely — the intent is "just these
  // skills", and connectors are a separate, gated concern.
  const onlySet = only && only.length ? new Set(only) : null;
  const prefix = gh.subdir ? `${gh.subdir}/` : "";
  const fetchFn = await ghFetch();
  // Pin gh.ref (a branch/tag/HEAD) to a concrete commit, then pull the tree AND
  // every file AT that SHA — a single consistent snapshot (no TOCTOU if the branch
  // moves mid-build) and a provenance record of exactly what was resolved.
  const commit = await resolveCommit(gh.owner, gh.repo, gh.ref, fetchFn);
  const tree = await ghTree(gh.owner, gh.repo, commit.sha, fetchFn);
  const raw = (path: string) => ghRaw(gh.owner, gh.repo, commit.sha, path, fetchFn);

  const notes: string[] = [];
  const connectors: PlannedConnector[] = [];
  const skills: PlannedSkill[] = [];
  const ignored: { type: string; count: number }[] = [];
  let version: string | undefined;
  let displayName: string | undefined;
  // Set when a routed stdio server bundles files (${CLAUDE_PLUGIN_ROOT}); triggers
  // collecting the plugin tree for runtime materialization.
  let needsFiles = false;

  // ── Plugin manifest (.claude-plugin/plugin.json) — better metadata + MCP ──
  // `mcpServers` per the plugin schema is string | array | object: a config-file
  // path, a mix of paths and inline maps, or a single inline map. Inline maps
  // apply directly; path references are fetched below.
  let inlineServers: Record<string, ServerDef> = {};
  let manifestPaths: string[] = [];
  const pjPath = `${prefix}.claude-plugin/plugin.json`;
  if (tree.some((t) => t.path === pjPath)) {
    try {
      const pj = JSON.parse((await raw(pjPath)) ?? "{}") as Record<string, unknown>;
      if (typeof pj.version === "string") version = pj.version;
      if (typeof pj.displayName === "string") displayName = pj.displayName;
      if (pj.mcpServers != null) {
        const parsed = parseManifestMcp(pj.mcpServers);
        inlineServers = parsed.inline;
        manifestPaths = parsed.paths;
      }
    } catch { /* tolerate a malformed manifest */ }
  }

  // Which file each server name came from, for `originKey`. Overwritten in the same
  // order as the precedence merge below, so the winner names its own source.
  const origin = new Map<string, string>();
  for (const name of Object.keys(inlineServers)) origin.set(name, `.claude-plugin/plugin.json#${name}`);

  // Config files referenced by plugin.json `mcpServers` (path/array forms).
  const pathServers: Record<string, ServerDef> = {};
  for (const rel of manifestPaths) {
    const full = `${prefix}${rel}`;
    if (!tree.some((t) => t.path === full)) { notes.push(`${rel}: referenced MCP config not found`); continue; }
    try {
      const txt = await raw(full);
      const found = extractServers(txt ? JSON.parse(txt) : {});
      for (const name of Object.keys(found)) origin.set(name, `${rel}#${name}`);
      Object.assign(pathServers, found);
    } catch (e) {
      notes.push(`${rel} could not be read: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  let fileServers: Record<string, ServerDef> = {};
  if (tree.some((t) => t.path === `${prefix}.mcp.json`)) {
    try {
      const mcpRaw = await raw(`${prefix}.mcp.json`);
      fileServers = extractServers(mcpRaw ? JSON.parse(mcpRaw) : {});
      for (const name of Object.keys(fileServers)) origin.set(name, `.mcp.json#${name}`);
    } catch (e) {
      notes.push(`.mcp.json could not be read: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  // Precedence on a name clash: inline < referenced config < root .mcp.json.
  const servers = { ...inlineServers, ...pathServers, ...fileServers };
  if (!onlySet) {
    for (const [sname, def] of Object.entries(servers)) {
      const result = planConnector(sname, origin.get(sname) ?? `#${sname}`, def);
      if (!result) continue;
      if ("skipped" in result) { notes.push(result.skipped); continue; }
      if (result.note) notes.push(result.note);
      if (result.routed.bundled) needsFiles = true;
      connectors.push(result.routed);
    }
  }

  // ── Skills (skills/<name>/SKILL.md + bundled files) ────────────────────────
  const skillMds = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${prefix}skills/`) && t.path.endsWith("/SKILL.md"));
  for (const md of skillMds) {
    const dir = md.path.slice(0, -"/SKILL.md".length);
    const body = await raw(md.path);
    if (!body) continue;
    let parsed;
    try { parsed = parseSkillMarkdown(body); } catch { continue; }
    if (!parsed.name) continue;
    if (onlySet && !onlySet.has(parsed.name)) continue;
    const files: { path: string; content: string }[] = [];
    const sibs = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${dir}/`) && t.path !== md.path).slice(0, MAX_SKILL_FILES);
    for (const f of sibs) {
      const content = await raw(f.path);
      if (content == null) continue;
      files.push({ path: f.path.slice(dir.length + 1), content: Buffer.from(content, "utf8").toString("base64") });
    }
    skills.push({ name: parsed.name, originPath: dir.slice(prefix.length), raw: body, parsed, files });
  }

  // ── Commands → skills (Anthropic converged commands→skills) ────────────────
  const cmds = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${prefix}commands/`) && t.path.endsWith(".md"));
  for (const c of cmds) {
    const body = await raw(c.path);
    if (!body) continue;
    let parsed: ReturnType<typeof parseSkillMarkdown> | null = null;
    try { parsed = parseSkillMarkdown(body); } catch { parsed = null; }
    const base = c.path.split("/").pop()!.replace(/\.md$/, "");
    const finalParsed: ReturnType<typeof parseSkillMarkdown> = parsed && parsed.name ? parsed : { name: base, description: undefined, body, frontmatter: {} };
    if (onlySet && !onlySet.has(finalParsed.name)) continue;
    skills.push({ name: finalParsed.name, originPath: c.path.slice(prefix.length), raw: body, parsed: finalParsed, files: [] });
  }

  // ── Components we preserve but don't activate ──────────────────────────────
  for (const d of IGNORED_DIRS) {
    const count = tree.filter((t: TreeEntry) => t.type === "blob" && t.path.startsWith(`${prefix}${d}/`)).length;
    if (count) ignored.push({ type: d, count });
  }

  // ── Bundled plugin files (only when a bundled server was routed) ────────────
  // Stored relative to the plugin root; materialized into /plugins/<installId> in
  // the sandbox at run time. Capped per-file + total so a hostile plugin can't
  // bloat storage or the sandbox.
  const files: { path: string; content: string }[] = [];
  if (needsFiles) {
    let total = 0;
    for (const p of selectPluginFiles(tree, prefix, { maxFiles: MAX_PLUGIN_FILES })) {
      const content = await raw(p);
      if (content == null) continue;
      const bytes = Buffer.byteLength(content, "utf8");
      const rel = p.slice(prefix.length);
      if (bytes > MAX_PLUGIN_FILE_BYTES) { notes.push(`${rel}: file too large, skipped`); continue; }
      if (total + bytes > MAX_PLUGIN_TOTAL_BYTES) { notes.push(`plugin files exceed the size cap; some were skipped`); break; }
      total += bytes;
      files.push({ path: rel, content: Buffer.from(content, "utf8").toString("base64") });
    }
  }

  return { commit, version, displayName, connectors, skills, ignored, notes, files, needsFiles };
}

/**
 * Every decision `routeServer` used to make while writing, as a value.
 *
 * Three outcomes, kept distinct so a skipped definition can never leak into
 * `plan.connectors`: the old code returned before its push, and `manifest.connectors`
 * must not gain an entry it did not have.
 */
type PlanConnectorResult =
  | { routed: PlannedConnector; note?: string }
  | { skipped: string }
  | null;

function planConnector(name: string, originKey: string, def: ServerDef): PlanConnectorResult {
  if (!def || typeof def !== "object") return null;
  // Local (stdio) server — runs inside the session sandbox (the trust boundary).
  // Bare-command servers (npx/uvx/etc.) and bundled ones pointing at
  // ${CLAUDE_PLUGIN_ROOT} are both routed; bundled ones additionally store the
  // plugin tree (materialized + ${CLAUDE_PLUGIN_ROOT}-substituted at run time).
  if (def.command || def.type === "stdio") {
    if (!def.command) return { skipped: `${name}: local server has no command, skipped` };
    // command/args/env keep their ${CLAUDE_PLUGIN_ROOT} literal — substituted per
    // session at connect time. Only NON-resolvable ${...} (a real secret) gates.
    const bundled = refsPluginRoot(serverDefParts(def));
    const envUnresolved = def.env ? Object.values(def.env).some(hasUnresolvedPlaceholder) : false;
    // Consent gate: EVERY stdio server from a marketplace runs third-party code in
    // the user's sandbox — a bundled plugin's code OR a bare `npx`/`uvx`/`pip`
    // command that fetches and executes a remote package. The bundled vs
    // bare-command distinction is irrelevant to the threat, so the writer installs
    // ALL of them OFF; these notes only differ in what the admin has to do next.
    const note = bundled
      ? `${name}: ships code that runs in users' sandboxes — review and enable it in Extensions`
      : envUnresolved
        ? `${name}: needs configuration — open Connectors to finish`
        : `${name}: runs third-party code in your sandbox — review and enable it in Extensions`;
    return {
      routed: { name, originKey, kind: "stdio", command: def.command, args: def.args, env: def.env,
                bundled, envUnresolved, hasPlaceholder: false },
      note,
    };
  }
  if (!def.url) return { skipped: `${name}: no URL, skipped` };
  const hasPlaceholder = def.headers ? JSON.stringify(def.headers).includes("${") : false;
  return {
    routed: { name, originKey, kind: "remote", url: def.url, headers: def.headers,
              bundled: false, envUnresolved: false, hasPlaceholder },
    ...(hasPlaceholder ? { note: `${name}: needs an access key — open Connectors to add it` } : {}),
  };
}
