import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls, pluginMarketplaces, skills, mcpServers } from "@/lib/db/schema";
import { createGuardedFetch } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls, getSetting } from "@/lib/settings";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import { ingestSkill } from "@/lib/skills/service";
import { upsertServer, setEnabled } from "@/lib/mcp/service";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { parseGitHubUrl, resolveGitHub } from "./source";
import { ghTree, ghRaw, type TreeEntry } from "./fetch";
import type { CatalogItem, InstallManifest } from "./types";

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
function extractServers(json: unknown): Record<string, { type?: string; url?: string; headers?: Record<string, string>; command?: string }> {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (o.mcpServers && typeof o.mcpServers === "object") return o.mcpServers as never;
    return o as never;
  }
  return {};
}

/** Install one plugin from an added marketplace into A (skills) + B (connectors),
 *  tagging every routed row `catalog:<installId>` for clean uninstall. */
export async function installPlugin(opts: { marketplaceId: string; pluginName: string; installedBy: string }): Promise<InstallManifest> {
  const mkRow = (await db.select().from(pluginMarketplaces).where(eq(pluginMarketplaces.id, opts.marketplaceId)).limit(1))[0];
  if (!mkRow) throw new Error("Marketplace not found");
  const mktRepo = parseGitHubUrl(mkRow.url);
  if (!mktRepo) throw new Error("Marketplace is not a GitHub repo");

  const item = ((mkRow.catalog ?? []) as CatalogItem[]).find((c) => c.name === opts.pluginName);
  if (!item) throw new Error("Plugin not found in this marketplace");
  const gh = resolveGitHub(item.source, mktRepo);
  if (!gh) throw new Error("This plugin's source isn't installable yet (non-GitHub).");

  const installId = nanoid();
  const tag = `catalog:${installId}`;
  const prefix = gh.subdir ? `${gh.subdir}/` : "";
  const fetchFn = await ghFetch();
  const tree = await ghTree(gh.owner, gh.repo, gh.ref, fetchFn);

  const manifest: InstallManifest = { skills: [], connectors: [], ignored: [], notes: [] };
  const raw = (path: string) => ghRaw(gh.owner, gh.repo, gh.ref, path, fetchFn);

  // ── Remote MCP connectors (.mcp.json) ──────────────────────────────────────
  if (tree.some((t) => t.path === `${prefix}.mcp.json`)) {
    try {
      const mcpRaw = await raw(`${prefix}.mcp.json`);
      const servers = extractServers(mcpRaw ? JSON.parse(mcpRaw) : {});
      for (const [sname, def] of Object.entries(servers)) {
        if (!def || typeof def !== "object") continue;
        if (def.command || def.type === "stdio") { manifest.notes.push(`${sname}: local (stdio) server — not supported yet`); continue; }
        if (!def.url) { manifest.notes.push(`${sname}: no URL, skipped`); continue; }
        const hasPlaceholder = def.headers ? JSON.stringify(def.headers).includes("${") : false;
        const secrets = def.headers && !hasPlaceholder ? { headers: def.headers } : undefined;
        let authKind: "token" | "oauth" = "token";
        try { authKind = await detectAuthKind(def.url); } catch { /* default token */ }
        const id = await upsertServer({ scope: "system", userId: null, projectId: null, name: sname, url: def.url, secrets, authKind, source: tag });
        if (hasPlaceholder) { await setEnabled(id, false); manifest.notes.push(`${sname}: needs an access key — open Connectors to add it`); }
        manifest.connectors.push(sname);
      }
    } catch (e) {
      manifest.notes.push(`.mcp.json could not be read: ${e instanceof Error ? e.message : "error"}`);
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

  await db.insert(pluginInstalls).values({
    id: installId, marketplaceId: opts.marketplaceId, pluginName: opts.pluginName,
    version: gh.ref, scope: "system", manifest: manifest as unknown as Record<string, unknown>, installedBy: opts.installedBy,
  });
  return manifest;
}

/** Remove everything an install routed (FK cascade drops skill files + oauth rows). */
export async function uninstallPlugin(installId: string): Promise<void> {
  const tag = `catalog:${installId}`;
  await db.delete(skills).where(eq(skills.source, tag));
  await db.delete(mcpServers).where(eq(mcpServers.source, tag));
  await db.delete(pluginInstalls).where(eq(pluginInstalls.id, installId));
}
