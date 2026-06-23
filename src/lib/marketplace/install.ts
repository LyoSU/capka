import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls, pluginMarketplaces, pluginFiles, skills, mcpServers } from "@/lib/db/schema";
import { createGuardedFetch } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls, getSetting } from "@/lib/settings";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import { ingestSkill } from "@/lib/skills/service";
import { upsertServer, upsertStdioServer, setEnabled } from "@/lib/mcp/service";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { parseGitHubUrl, resolveGitHub } from "./source";
import { ghTree, ghRaw, type TreeEntry } from "./fetch";
import { extractServers, parseManifestMcp, type ServerDef } from "./manifest";
import { refsPluginRoot, hasUnresolvedPlaceholder, serverDefParts, selectPluginFiles } from "./plugin-root";
import type { CatalogItem, GitHubRef, InstallManifest } from "./types";

const IGNORED_DIRS = ["agents", "hooks", "lspServers", "outputStyles"];
const MAX_SKILL_FILES = 50;
// Caps on a plugin's bundled file tree (materialized into every user's sandbox),
// so a fat or hostile plugin can't bloat the DB or the sandbox.
const MAX_PLUGIN_FILES = 200;
const MAX_PLUGIN_FILE_BYTES = 1_000_000;
const MAX_PLUGIN_TOTAL_BYTES = 5_000_000;

/** Where a plugin's skills + connectors are routed: org-wide (system) or personal
 *  (user). A member install is `{ scope: "user", userId: <them> }`. */
interface InstallTarget { scope: "system" | "user"; userId: string | null; projectId: string | null }

/** What a single plugin pull produced: the public manifest + the bundled files to
 *  persist for runtime materialization (kept out of the manifest JSON, which is
 *  small + user-facing). */
interface ApplyResult { manifest: InstallManifest; files: { path: string; content: string }[] }

/** Delete skills/connectors this install owns that the latest tree no longer
 *  produces (upstream removals). Keyed by the install tag. */
async function pruneRemoved(tag: string, manifest: InstallManifest): Promise<void> {
  const keepSkills = new Set(manifest.skills);
  const keepConnectors = new Set(manifest.connectors);
  const ownedSkills = await db.select({ id: skills.id, name: skills.name }).from(skills).where(eq(skills.source, tag));
  for (const s of ownedSkills) {
    if (!keepSkills.has(s.name)) await db.delete(skills).where(eq(skills.id, s.id));
  }
  const ownedConnectors = await db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.source, tag));
  for (const c of ownedConnectors) {
    if (!keepConnectors.has(c.name)) await db.delete(mcpServers).where(eq(mcpServers.id, c.id));
  }
}

/** Replace the bundled-file set for an install (delete-then-insert keeps upgrade
 *  in sync with the new tree). */
async function persistPluginFiles(installId: string, files: { path: string; content: string }[]): Promise<void> {
  await db.delete(pluginFiles).where(eq(pluginFiles.installId, installId));
  if (files.length) {
    await db.insert(pluginFiles).values(files.map((f) => ({ id: nanoid(), installId, path: f.path, content: f.content })));
  }
}

/** Guarded GitHub fetch with API headers + optional token (rate limits). */
async function ghFetch(): Promise<typeof fetch> {
  const token = await getSetting("github_token");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "unclaw" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls(), headers, timeoutMs: 15_000 });
}

/** Resolve a (marketplace, plugin) to its GitHub location + catalog entry. */
async function resolvePlugin(marketplaceId: string, pluginName: string) {
  const mkRow = (await db.select().from(pluginMarketplaces).where(eq(pluginMarketplaces.id, marketplaceId)).limit(1))[0];
  if (!mkRow) throw new Error("Marketplace not found");
  const mktRepo = parseGitHubUrl(mkRow.url);
  if (!mktRepo) throw new Error("Marketplace is not a GitHub repo");
  const item = ((mkRow.catalog ?? []) as CatalogItem[]).find((c) => c.name === pluginName);
  if (!item) throw new Error("Plugin not found in this marketplace");
  const gh = resolveGitHub(item.source, mktRepo);
  if (!gh) throw new Error("This plugin's source isn't installable yet (non-GitHub).");
  return { gh };
}

/** Pull a plugin's files from GitHub and route them into skills + connectors,
 *  tagging every row `catalog:<installId>`. Idempotent per name: ingestSkill /
 *  upsertServer upsert by name, so re-running with the same tag updates in place
 *  (the basis of upgrade). Returns what the current tree produced. */
async function applyPlugin(gh: GitHubRef, tag: string, target: InstallTarget): Promise<ApplyResult> {
  const prefix = gh.subdir ? `${gh.subdir}/` : "";
  const fetchFn = await ghFetch();
  const tree = await ghTree(gh.owner, gh.repo, gh.ref, fetchFn);

  const manifest: InstallManifest = { skills: [], connectors: [], ignored: [], notes: [] };
  const raw = (path: string) => ghRaw(gh.owner, gh.repo, gh.ref, path, fetchFn);
  // Set when a routed stdio server bundles files (${CLAUDE_PLUGIN_ROOT}); triggers
  // storing the plugin tree for runtime materialization.
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
      if (typeof pj.version === "string") manifest.version = pj.version;
      if (typeof pj.displayName === "string") manifest.displayName = pj.displayName;
      if (pj.mcpServers != null) {
        const parsed = parseManifestMcp(pj.mcpServers);
        inlineServers = parsed.inline;
        manifestPaths = parsed.paths;
      }
    } catch { /* tolerate a malformed manifest */ }
  }

  // ── MCP connectors (.mcp.json + plugin.json mcpServers, inline & referenced) ──
  async function routeServer(sname: string, def: ServerDef) {
    if (!def || typeof def !== "object") return;
    // Local (stdio) server — runs inside the session sandbox (the trust boundary).
    // Bare-command servers (npx/uvx/etc.) and bundled ones pointing at
    // ${CLAUDE_PLUGIN_ROOT} are both routed; bundled ones additionally store the
    // plugin tree (materialized + ${CLAUDE_PLUGIN_ROOT}-substituted at run time).
    if (def.command || def.type === "stdio") {
      if (!def.command) { manifest.notes.push(`${sname}: local server has no command, skipped`); return; }
      // command/args/env keep their ${CLAUDE_PLUGIN_ROOT} literal — substituted per
      // session at connect time. Only NON-resolvable ${...} (a real secret) gates.
      const bundled = refsPluginRoot(serverDefParts(def));
      const envUnresolved = def.env ? Object.values(def.env).some(hasUnresolvedPlaceholder) : false;
      const sid = await upsertStdioServer({ ...target, name: sname, command: def.command, args: def.args, env: def.env, source: tag });
      if (bundled) {
        // Safety gate for a mass-user platform: a bundled server runs third-party
        // CODE in every user's sandbox. Install it OFF; an admin reviews + enables
        // it from Extensions. (Sandbox isolation is the containment; this is consent.)
        needsFiles = true;
        await setEnabled(sid, false);
        manifest.notes.push(`${sname}: ships code that runs in users' sandboxes — review and enable it in Extensions`);
      } else if (envUnresolved) {
        await setEnabled(sid, false);
        manifest.notes.push(`${sname}: needs configuration — open Connectors to finish`);
      }
      manifest.connectors.push(sname);
      return;
    }
    if (!def.url) { manifest.notes.push(`${sname}: no URL, skipped`); return; }
    const hasPlaceholder = def.headers ? JSON.stringify(def.headers).includes("${") : false;
    const secrets = def.headers && !hasPlaceholder ? { headers: def.headers } : undefined;
    let authKind: "token" | "oauth" = "token";
    try { authKind = await detectAuthKind(def.url); } catch { /* default token */ }
    const id = await upsertServer({ ...target, name: sname, url: def.url, secrets, authKind, source: tag });
    if (hasPlaceholder) { await setEnabled(id, false); manifest.notes.push(`${sname}: needs an access key — open Connectors to add it`); }
    manifest.connectors.push(sname);
  }

  // Config files referenced by plugin.json `mcpServers` (path/array forms).
  const pathServers: Record<string, ServerDef> = {};
  for (const rel of manifestPaths) {
    const full = `${prefix}${rel}`;
    if (!tree.some((t) => t.path === full)) { manifest.notes.push(`${rel}: referenced MCP config not found`); continue; }
    try {
      const txt = await raw(full);
      Object.assign(pathServers, extractServers(txt ? JSON.parse(txt) : {}));
    } catch (e) {
      manifest.notes.push(`${rel} could not be read: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  let fileServers: Record<string, ServerDef> = {};
  if (tree.some((t) => t.path === `${prefix}.mcp.json`)) {
    try {
      const mcpRaw = await raw(`${prefix}.mcp.json`);
      fileServers = extractServers(mcpRaw ? JSON.parse(mcpRaw) : {});
    } catch (e) {
      manifest.notes.push(`.mcp.json could not be read: ${e instanceof Error ? e.message : "error"}`);
    }
  }
  // Precedence on a name clash: inline < referenced config < root .mcp.json.
  const servers = { ...inlineServers, ...pathServers, ...fileServers };
  for (const [sname, def] of Object.entries(servers)) await routeServer(sname, def);

  // ── Skills (skills/<name>/SKILL.md + bundled files) ────────────────────────
  const skillMds = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${prefix}skills/`) && t.path.endsWith("/SKILL.md"));
  for (const md of skillMds) {
    const dir = md.path.slice(0, -"/SKILL.md".length);
    const body = await raw(md.path);
    if (!body) continue;
    let parsed;
    try { parsed = parseSkillMarkdown(body); } catch { continue; }
    if (!parsed.name) continue;
    const files: { path: string; content: string }[] = [];
    const sibs = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${dir}/`) && t.path !== md.path).slice(0, MAX_SKILL_FILES);
    for (const f of sibs) {
      const content = await raw(f.path);
      if (content == null) continue;
      files.push({ path: f.path.slice(dir.length + 1), content: Buffer.from(content, "utf8").toString("base64") });
    }
    await ingestSkill(parsed, files, { ...target, source: tag });
    manifest.skills.push(parsed.name);
  }

  // ── Commands → skills (Anthropic converged commands→skills) ────────────────
  const cmds = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${prefix}commands/`) && t.path.endsWith(".md"));
  for (const c of cmds) {
    const body = await raw(c.path);
    if (!body) continue;
    let parsed: ReturnType<typeof parseSkillMarkdown> | null = null;
    try { parsed = parseSkillMarkdown(body); } catch { parsed = null; }
    const base = c.path.split("/").pop()!.replace(/\.md$/, "");
    const finalParsed = parsed && parsed.name ? parsed : { name: base, description: undefined, body, frontmatter: {} };
    await ingestSkill(finalParsed, [], { ...target, source: tag });
    manifest.skills.push(finalParsed.name);
  }

  // ── Components we preserve but don't activate ──────────────────────────────
  for (const d of IGNORED_DIRS) {
    const count = tree.filter((t: TreeEntry) => t.type === "blob" && t.path.startsWith(`${prefix}${d}/`)).length;
    if (count) manifest.ignored.push({ type: d, count });
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
      if (bytes > MAX_PLUGIN_FILE_BYTES) { manifest.notes.push(`${rel}: file too large, skipped`); continue; }
      if (total + bytes > MAX_PLUGIN_TOTAL_BYTES) { manifest.notes.push(`plugin files exceed the size cap; some were skipped`); break; }
      total += bytes;
      files.push({ path: rel, content: Buffer.from(content, "utf8").toString("base64") });
    }
  }

  return { manifest, files };
}

/** Install one plugin from an added marketplace into A (skills) + B (connectors),
 *  tagging every routed row `catalog:<installId>` for clean uninstall. */
export async function installPlugin(opts: {
  marketplaceId: string;
  pluginName: string;
  installedBy: string;
  /** Org-wide (admin) or personal (a member installing for themselves). */
  scope?: "system" | "user";
}): Promise<InstallManifest> {
  const { gh } = await resolvePlugin(opts.marketplaceId, opts.pluginName);
  const scope = opts.scope ?? "system";
  const ownerId = scope === "user" ? opts.installedBy : null;
  const target: InstallTarget = { scope, userId: ownerId, projectId: null };

  // Idempotent per (marketplace, plugin, owner): re-installing reuses the same
  // install row + tag instead of duplicating. A member's personal install is
  // distinct from the org-wide one (matched by scope + userId).
  const existing = (await db.select({ id: pluginInstalls.id }).from(pluginInstalls)
    .where(and(
      eq(pluginInstalls.marketplaceId, opts.marketplaceId),
      eq(pluginInstalls.pluginName, opts.pluginName),
      eq(pluginInstalls.scope, scope),
      ownerId ? eq(pluginInstalls.userId, ownerId) : isNull(pluginInstalls.userId),
    )).limit(1))[0];
  const installId = existing?.id ?? nanoid();
  const { manifest, files } = await applyPlugin(gh, `catalog:${installId}`, target);

  if (existing) {
    await pruneRemoved(`catalog:${installId}`, manifest); // re-install: drop rows removed upstream
    await db.update(pluginInstalls)
      .set({ version: manifest.version ?? gh.ref, manifest: manifest as unknown as Record<string, unknown> })
      .where(eq(pluginInstalls.id, installId));
  } else {
    // Insert the install row before its files (pluginFiles FK → pluginInstalls).
    await db.insert(pluginInstalls).values({
      id: installId, marketplaceId: opts.marketplaceId, pluginName: opts.pluginName,
      version: manifest.version ?? gh.ref, scope, userId: ownerId,
      manifest: manifest as unknown as Record<string, unknown>, installedBy: opts.installedBy,
    });
  }
  await persistPluginFiles(installId, files);
  return manifest;
}

/** Re-pull an installed plugin from its source, keeping the same installId/tag so
 *  rows update in place. Skills/connectors removed upstream are pruned; the
 *  pluginInstalls row gets the fresh version + manifest. */
export async function upgradePlugin(installId: string): Promise<InstallManifest> {
  const row = (await db.select().from(pluginInstalls).where(eq(pluginInstalls.id, installId)).limit(1))[0];
  if (!row) throw new Error("Install not found");
  const { gh } = await resolvePlugin(row.marketplaceId, row.pluginName);
  const tag = `catalog:${installId}`;
  // Re-route into the same scope/owner the install already has.
  const target: InstallTarget = { scope: row.scope === "user" ? "user" : "system", userId: row.userId, projectId: null };

  const { manifest, files } = await applyPlugin(gh, tag, target);
  await persistPluginFiles(installId, files);
  await pruneRemoved(tag, manifest);

  await db.update(pluginInstalls)
    .set({ version: manifest.version ?? gh.ref, manifest: manifest as unknown as Record<string, unknown> })
    .where(eq(pluginInstalls.id, installId));
  return manifest;
}

/** Remove everything an install routed (FK cascade drops skill files, plugin
 *  files + oauth rows when the pluginInstalls row goes). */
export async function uninstallPlugin(installId: string): Promise<void> {
  const tag = `catalog:${installId}`;
  await db.delete(skills).where(eq(skills.source, tag));
  await db.delete(mcpServers).where(eq(mcpServers.source, tag));
  await db.delete(pluginInstalls).where(eq(pluginInstalls.id, installId));
}
