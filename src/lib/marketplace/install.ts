import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls, pluginMarketplaces, skills, mcpServers } from "@/lib/db/schema";
import { createGuardedFetch } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls, getSetting } from "@/lib/settings";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import { ingestSkill } from "@/lib/skills/service";
import { upsertServer, upsertStdioServer, setEnabled } from "@/lib/mcp/service";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { parseGitHubUrl, resolveGitHub } from "./source";
import { ghTree, ghRaw, type TreeEntry } from "./fetch";
import type { CatalogItem, GitHubRef, InstallManifest } from "./types";

const IGNORED_DIRS = ["agents", "hooks", "lspServers", "outputStyles"];
const MAX_SKILL_FILES = 50;

/** Guarded GitHub fetch with API headers + optional token (rate limits). */
async function ghFetch(): Promise<typeof fetch> {
  const token = await getSetting("github_token");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "unclaw" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls(), headers, timeoutMs: 15_000 });
}

/** Tolerate a missing `mcpServers` wrapper (some real .mcp.json files omit it). */
function extractServers(json: unknown): Record<string, { type?: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }> {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (o.mcpServers && typeof o.mcpServers === "object") return o.mcpServers as never;
    return o as never;
  }
  return {};
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
async function applyPlugin(gh: GitHubRef, tag: string): Promise<InstallManifest> {
  const prefix = gh.subdir ? `${gh.subdir}/` : "";
  const fetchFn = await ghFetch();
  const tree = await ghTree(gh.owner, gh.repo, gh.ref, fetchFn);

  const manifest: InstallManifest = { skills: [], connectors: [], ignored: [], notes: [] };
  const raw = (path: string) => ghRaw(gh.owner, gh.repo, gh.ref, path, fetchFn);

  // ── Plugin manifest (.claude-plugin/plugin.json) — better metadata + inline MCP ──
  let inlineServers: ReturnType<typeof extractServers> = {};
  const pjPath = `${prefix}.claude-plugin/plugin.json`;
  if (tree.some((t) => t.path === pjPath)) {
    try {
      const pj = JSON.parse((await raw(pjPath)) ?? "{}") as Record<string, unknown>;
      if (typeof pj.version === "string") manifest.version = pj.version;
      if (typeof pj.displayName === "string") manifest.displayName = pj.displayName;
      if (pj.mcpServers && typeof pj.mcpServers === "object" && !Array.isArray(pj.mcpServers)) {
        inlineServers = extractServers({ mcpServers: pj.mcpServers });
      }
    } catch { /* tolerate a malformed manifest */ }
  }

  // ── MCP connectors (.mcp.json + inline plugin.json mcpServers) ──────────────
  async function routeServer(sname: string, def: ReturnType<typeof extractServers>[string]) {
    if (!def || typeof def !== "object") return;
    // Local (stdio) server — runs inside the session sandbox. We route bare-command
    // servers (npx/uvx/etc.); bundled-binary ones pointing at ${CLAUDE_PLUGIN_ROOT}
    // need files we don't materialize yet, so skip those.
    if (def.command || def.type === "stdio") {
      if (!def.command) { manifest.notes.push(`${sname}: local server has no command, skipped`); return; }
      const refsPluginRoot = [def.command, ...(def.args ?? [])].some((s) => typeof s === "string" && s.includes("${CLAUDE_PLUGIN_ROOT}"));
      if (refsPluginRoot) { manifest.notes.push(`${sname}: bundled local server not supported yet (needs plugin files)`); return; }
      const envHasPlaceholder = def.env ? JSON.stringify(def.env).includes("${") : false;
      const env = def.env && !envHasPlaceholder ? def.env : undefined;
      const sid = await upsertStdioServer({ scope: "system", userId: null, projectId: null, name: sname, command: def.command, args: def.args, env, source: tag });
      if (envHasPlaceholder) { await setEnabled(sid, false); manifest.notes.push(`${sname}: needs configuration — open Connectors to finish`); }
      manifest.connectors.push(sname);
      return;
    }
    if (!def.url) { manifest.notes.push(`${sname}: no URL, skipped`); return; }
    const hasPlaceholder = def.headers ? JSON.stringify(def.headers).includes("${") : false;
    const secrets = def.headers && !hasPlaceholder ? { headers: def.headers } : undefined;
    let authKind: "token" | "oauth" = "token";
    try { authKind = await detectAuthKind(def.url); } catch { /* default token */ }
    const id = await upsertServer({ scope: "system", userId: null, projectId: null, name: sname, url: def.url, secrets, authKind, source: tag });
    if (hasPlaceholder) { await setEnabled(id, false); manifest.notes.push(`${sname}: needs an access key — open Connectors to add it`); }
    manifest.connectors.push(sname);
  }

  let fileServers: ReturnType<typeof extractServers> = {};
  if (tree.some((t) => t.path === `${prefix}.mcp.json`)) {
    try {
      const mcpRaw = await raw(`${prefix}.mcp.json`);
      fileServers = extractServers(mcpRaw ? JSON.parse(mcpRaw) : {});
    } catch (e) {
      manifest.notes.push(`.mcp.json could not be read: ${e instanceof Error ? e.message : "error"}`);
    }
  }
  // .mcp.json wins over inline on a name clash.
  const servers = { ...inlineServers, ...fileServers };
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
    await ingestSkill(parsed, files, { scope: "system", userId: null, projectId: null, source: tag });
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
    await ingestSkill(finalParsed, [], { scope: "system", userId: null, projectId: null, source: tag });
    manifest.skills.push(finalParsed.name);
  }

  // ── Components we preserve but don't activate ──────────────────────────────
  for (const d of IGNORED_DIRS) {
    const count = tree.filter((t: TreeEntry) => t.type === "blob" && t.path.startsWith(`${prefix}${d}/`)).length;
    if (count) manifest.ignored.push({ type: d, count });
  }

  return manifest;
}

/** Install one plugin from an added marketplace into A (skills) + B (connectors),
 *  tagging every routed row `catalog:<installId>` for clean uninstall. */
export async function installPlugin(opts: { marketplaceId: string; pluginName: string; installedBy: string }): Promise<InstallManifest> {
  const { gh } = await resolvePlugin(opts.marketplaceId, opts.pluginName);
  const installId = nanoid();
  const manifest = await applyPlugin(gh, `catalog:${installId}`);

  await db.insert(pluginInstalls).values({
    id: installId, marketplaceId: opts.marketplaceId, pluginName: opts.pluginName,
    version: manifest.version ?? gh.ref, scope: "system", manifest: manifest as unknown as Record<string, unknown>, installedBy: opts.installedBy,
  });
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

  const manifest = await applyPlugin(gh, tag);

  // Prune rows this install owns that the new tree no longer produces.
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

  await db.update(pluginInstalls)
    .set({ version: manifest.version ?? gh.ref, manifest: manifest as unknown as Record<string, unknown> })
    .where(eq(pluginInstalls.id, installId));
  return manifest;
}

/** Remove everything an install routed (FK cascade drops skill files + oauth rows). */
export async function uninstallPlugin(installId: string): Promise<void> {
  const tag = `catalog:${installId}`;
  await db.delete(skills).where(eq(skills.source, tag));
  await db.delete(mcpServers).where(eq(mcpServers.source, tag));
  await db.delete(pluginInstalls).where(eq(pluginInstalls.id, installId));
}
