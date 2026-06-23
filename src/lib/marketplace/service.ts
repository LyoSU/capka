import { nanoid } from "nanoid";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginMarketplaces, pluginInstalls, skills, mcpServers } from "@/lib/db/schema";
import { createGuardedFetch } from "@/lib/net/ssrf";
import { getBlockPrivateProviderUrls, getSetting } from "@/lib/settings";
import { ValidationError } from "@/lib/errors";
import { parseGitHubUrl } from "./source";
import { ghRaw, parseMarketplace } from "./fetch";
import type { CatalogItem } from "./types";

async function ghFetch(): Promise<typeof fetch> {
  const token = await getSetting("github_token");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "unclaw" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return createGuardedFetch({ blockPrivate: await getBlockPrivateProviderUrls(), headers, timeoutMs: 15_000 });
}

/** Fetch + normalize a marketplace's plugin catalog from its GitHub repo. */
async function fetchCatalog(url: string): Promise<{ name: string; owner: string | null; items: CatalogItem[] }> {
  const repo = parseGitHubUrl(url);
  if (!repo) throw new ValidationError("Only GitHub marketplaces are supported. Paste a github.com repo URL.");
  const fetchFn = await ghFetch();
  const raw =
    (await ghRaw(repo.owner, repo.repo, "HEAD", ".claude-plugin/marketplace.json", fetchFn)) ??
    (await ghRaw(repo.owner, repo.repo, "HEAD", "marketplace.json", fetchFn));
  if (!raw) throw new ValidationError("No marketplace.json found in that repo.");
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new ValidationError("That marketplace.json isn't valid JSON."); }
  return parseMarketplace(json, repo);
}

export async function addMarketplace(url: string): Promise<string> {
  const clean = url.trim();
  const { name, owner, items } = await fetchCatalog(clean);
  const id = nanoid();
  await db.insert(pluginMarketplaces).values({ id, url: clean, name, owner, catalog: items, refreshedAt: new Date() });
  return id;
}

export async function refreshMarketplace(id: string): Promise<void> {
  const row = (await db.select().from(pluginMarketplaces).where(eq(pluginMarketplaces.id, id)).limit(1))[0];
  if (!row) throw new ValidationError("Marketplace not found.");
  const { name, owner, items } = await fetchCatalog(row.url);
  await db.update(pluginMarketplaces).set({ name, owner, catalog: items, refreshedAt: new Date() }).where(eq(pluginMarketplaces.id, id));
}

export async function deleteMarketplace(id: string): Promise<void> {
  await db.delete(pluginMarketplaces).where(eq(pluginMarketplaces.id, id));
}

export async function listMarketplaces() {
  const rows = await db.select().from(pluginMarketplaces);
  return rows.map((r) => ({
    id: r.id, url: r.url, name: r.name, owner: r.owner,
    pluginCount: (r.catalog ?? []).length, refreshedAt: r.refreshedAt,
  }));
}

/** A marketplace's catalog, each item flagged with whether it's installed. */
export async function getCatalog(marketplaceId: string): Promise<(CatalogItem & { installed: boolean })[]> {
  const row = (await db.select().from(pluginMarketplaces).where(eq(pluginMarketplaces.id, marketplaceId)).limit(1))[0];
  if (!row) return [];
  const installs = await db.select({ name: pluginInstalls.pluginName }).from(pluginInstalls).where(eq(pluginInstalls.marketplaceId, marketplaceId));
  const installed = new Set(installs.map((i) => i.name));
  return ((row.catalog ?? []) as CatalogItem[]).map((c) => ({ ...c, installed: installed.has(c.name) }));
}

export async function listInstalls() {
  return db.select().from(pluginInstalls);
}

/** Display metadata for a set of install ids (for attributing routed skills to
 *  their plugin: name, author, homepage). Keyed by installId. */
export async function getInstallMeta(
  installIds: string[],
): Promise<Map<string, { pluginName: string; author: string | null; homepage: string | null }>> {
  const out = new Map<string, { pluginName: string; author: string | null; homepage: string | null }>();
  if (installIds.length === 0) return out;
  const installs = await db
    .select({ id: pluginInstalls.id, pluginName: pluginInstalls.pluginName, marketplaceId: pluginInstalls.marketplaceId })
    .from(pluginInstalls)
    .where(inArray(pluginInstalls.id, installIds));
  const mktIds = [...new Set(installs.map((i) => i.marketplaceId))];
  const markets = mktIds.length
    ? await db.select({ id: pluginMarketplaces.id, catalog: pluginMarketplaces.catalog }).from(pluginMarketplaces).where(inArray(pluginMarketplaces.id, mktIds))
    : [];
  const catalogByMkt = new Map(markets.map((m) => [m.id, (m.catalog ?? []) as CatalogItem[]]));
  for (const i of installs) {
    const item = catalogByMkt.get(i.marketplaceId)?.find((c) => c.name === i.pluginName);
    out.set(i.id, { pluginName: i.pluginName, author: item?.author ?? null, homepage: item?.homepage ?? null });
  }
  return out;
}

export type PluginEnabledState = "on" | "off" | "mixed";

/** Installed plugins, each grouped with the skills + connectors it routed, so the
 *  Extensions page can show — and act on — a plugin as one unit (no more hunting
 *  scattered rows across the Skills and Connectors pages). */
export async function listInstalledPlugins() {
  const installs = await db.select().from(pluginInstalls);
  if (!installs.length) return [];
  const tags = installs.map((i) => `catalog:${i.id}`);
  const [skillRows, connRows, meta] = await Promise.all([
    db.select({ id: skills.id, name: skills.name, enabled: skills.enabled, source: skills.source }).from(skills).where(inArray(skills.source, tags)),
    db.select({ id: mcpServers.id, name: mcpServers.name, enabled: mcpServers.enabled, transport: mcpServers.transport, source: mcpServers.source }).from(mcpServers).where(inArray(mcpServers.source, tags)),
    getInstallMeta(installs.map((i) => i.id)),
  ]);
  return installs.map((i) => {
    const tag = `catalog:${i.id}`;
    const pluginSkills = skillRows.filter((r) => r.source === tag).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled }));
    const connectors = connRows.filter((r) => r.source === tag).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, transport: r.transport }));
    const items = [...pluginSkills, ...connectors];
    const enabledState: PluginEnabledState =
      items.length === 0 || items.every((x) => x.enabled) ? "on" : items.some((x) => x.enabled) ? "mixed" : "off";
    const m = (i.manifest ?? {}) as { displayName?: string; notes?: string[] };
    return {
      id: i.id,
      pluginName: i.pluginName,
      displayName: m.displayName ?? null,
      version: i.version,
      author: meta.get(i.id)?.author ?? null,
      homepage: meta.get(i.id)?.homepage ?? null,
      createdAt: i.createdAt,
      enabledState,
      notes: Array.isArray(m.notes) ? m.notes : [],
      skills: pluginSkills,
      connectors,
    };
  });
}

/** Flip enabled on every skill + connector a plugin routed — one action for the
 *  whole group (the data model already filters runtime use by `enabled`). */
export async function setPluginEnabled(installId: string, enabled: boolean): Promise<void> {
  const tag = `catalog:${installId}`;
  const now = new Date();
  await db.update(skills).set({ enabled, updatedAt: now }).where(eq(skills.source, tag));
  await db.update(mcpServers).set({ enabled, updatedAt: now }).where(eq(mcpServers.source, tag));
}

/** The install id for a (marketplace, plugin), or null. */
export async function findInstall(marketplaceId: string, pluginName: string): Promise<string | null> {
  const all = await db.select({ id: pluginInstalls.id, name: pluginInstalls.pluginName })
    .from(pluginInstalls).where(eq(pluginInstalls.marketplaceId, marketplaceId));
  return all.find((i) => i.name === pluginName)?.id ?? null;
}
