import { nanoid } from "nanoid";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginMarketplaces, pluginInstalls, skills, mcpServers } from "@/lib/db/schema";
import { mutedIds, setMuted } from "@/lib/muted-resources";
import { ValidationError } from "@/lib/errors";
import { parseGitHubUrl } from "./source";
import { ghFetch, ghRaw, parseMarketplace } from "./fetch";
import { discoverSkills } from "./discover";
import { readStoredManifest } from "./manifest-store";
import type { CatalogItem } from "./types";

/** Fetch + normalize a marketplace's plugin catalog from its GitHub repo. */
async function fetchCatalog(url: string): Promise<{ name: string; owner: string | null; items: CatalogItem[] }> {
  const repo = parseGitHubUrl(url);
  if (!repo) throw new ValidationError("Only GitHub marketplaces are supported. Paste a github.com repo URL.");
  const fetchFn = await ghFetch();
  const raw =
    (await ghRaw(repo.owner, repo.repo, "HEAD", ".claude-plugin/marketplace.json", fetchFn)) ??
    (await ghRaw(repo.owner, repo.repo, "HEAD", "marketplace.json", fetchFn));
  if (raw) {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new ValidationError("That marketplace.json isn't valid JSON."); }
    return parseMarketplace(json, repo);
  }
  // No marketplace.json — but a plain skills repo (skills/<name>/SKILL.md, à la
  // `npx skills add owner/repo`) is still installable: model the repo itself as a
  // single plugin (source ".") whose install pulls every skill. Fail only if it has
  // neither a catalog nor any skills.
  const { skills } = await discoverSkills({ owner: repo.owner, repo: repo.repo, ref: "HEAD", subdir: "" }, fetchFn);
  if (!skills.length) throw new ValidationError("No marketplace.json or skills/ folder found in that repo.");
  const item: CatalogItem = {
    name: repo.repo, description: `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
    author: repo.owner, category: null, homepage: null, kind: "plugin", source: ".", installable: true,
  };
  return { name: `${repo.owner}/${repo.repo}`, owner: repo.owner, items: [item] };
}

/** Dry-run the skills a repo would install (name + description), pinned to the
 *  current HEAD commit — the pre-install preview for "add a whole skills repo".
 *  Accepts a full github.com URL OR the `owner/repo` shorthand (parseGitHubUrl
 *  handles both). Advisory: throws only on a bad URL / unreachable repo. */
export async function discoverRepoSkills(url: string): Promise<{ owner: string; repo: string; sha: string; skills: { name: string; description: string | null }[] }> {
  const repo = parseGitHubUrl(url);
  if (!repo) throw new ValidationError("Only GitHub repositories are supported. Paste a github.com repo URL or owner/repo.");
  const fetchFn = await ghFetch();
  const { commit, skills } = await discoverSkills({ owner: repo.owner, repo: repo.repo, ref: "HEAD", subdir: "" }, fetchFn);
  return { owner: repo.owner, repo: repo.repo, sha: commit.sha, skills };
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

/** A marketplace's catalog, each item flagged with whether it's installed *for the
 *  viewer* — an org-wide (system) install, or this user's own personal one. */
export async function getCatalog(marketplaceId: string, userId?: string): Promise<(CatalogItem & { installed: boolean })[]> {
  const row = (await db.select().from(pluginMarketplaces).where(eq(pluginMarketplaces.id, marketplaceId)).limit(1))[0];
  if (!row) return [];
  const installs = await db.select({ name: pluginInstalls.pluginName }).from(pluginInstalls).where(and(
    eq(pluginInstalls.marketplaceId, marketplaceId),
    userId
      ? or(eq(pluginInstalls.scope, "system"), and(eq(pluginInstalls.scope, "user"), eq(pluginInstalls.userId, userId)))
      : undefined,
  ));
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

/** Installed plugins, each grouped with the skills + connectors it routed. Scoped
 *  to the viewer: org-wide (system) installs plus the viewer's own personal ones.
 *  `mine` marks a personal install the viewer owns (and may manage). */
export async function listInstalledPlugins(userId: string) {
  const installs = await db.select().from(pluginInstalls).where(
    or(eq(pluginInstalls.scope, "system"), and(eq(pluginInstalls.scope, "user"), eq(pluginInstalls.userId, userId))),
  );
  if (!installs.length) return [];
  const tags = installs.map((i) => `catalog:${i.id}`);
  const [skillRows, connRows, meta, mutedSkill, mutedMcp] = await Promise.all([
    db.select({ id: skills.id, name: skills.name, enabled: skills.enabled, source: skills.source }).from(skills).where(inArray(skills.source, tags)),
    db.select({ id: mcpServers.id, name: mcpServers.name, enabled: mcpServers.enabled, transport: mcpServers.transport, source: mcpServers.source }).from(mcpServers).where(inArray(mcpServers.source, tags)),
    getInstallMeta(installs.map((i) => i.id)),
    mutedIds(userId, "skill"),
    mutedIds(userId, "mcp"),
  ]);
  return installs.map((i) => {
    const tag = `catalog:${i.id}`;
    const pluginSkills = skillRows.filter((r) => r.source === tag).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled }));
    const connectors = connRows.filter((r) => r.source === tag).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, transport: r.transport }));
    const items = [...pluginSkills, ...connectors];
    const enabledState: PluginEnabledState =
      items.length === 0 || items.every((x) => x.enabled) ? "on" : items.some((x) => x.enabled) ? "mixed" : "off";
    // A member can't manage a shared (system) plugin, but can hide it for
    // themselves: muted when every one of its items is in their mute set.
    const ids = [...pluginSkills.map((s) => ({ id: s.id, set: mutedSkill })), ...connectors.map((c) => ({ id: c.id, set: mutedMcp }))];
    const mutedByMe = ids.length > 0 && ids.every((x) => x.set.has(x.id));
    // Through the central reader, not an inline cast: under the V2 layout these fields
    // live under `inventory`, and a cast would have kept compiling while rendering
    // blanks for every upgraded plugin.
    const stored = readStoredManifest(i.manifest);
    const m = stored.inventory;
    return {
      id: i.id,
      pluginName: i.pluginName,
      displayName: m.displayName ?? null,
      version: i.version,
      // Provenance: the pinned commit (short sha + date) for the Extensions UI.
      commitSha: i.commitSha,
      commitDate: m.commit?.date ?? null,
      author: meta.get(i.id)?.author ?? null,
      homepage: meta.get(i.id)?.homepage ?? null,
      createdAt: i.createdAt,
      enabledState,
      scope: i.scope,
      // The viewer owns this personal install → may manage it without being admin.
      mine: i.scope === "user" && i.userId === userId,
      mutedByMe,
      notes: Array.isArray(m.notes) ? m.notes : [],
      /**
       * Whether an apply is in flight or left unfinished.
       *
       * Load-bearing for legibility, not decoration: while an install is `applying` or
       * `failed`, the runtime hides ALL of its connectors and skills from every run
       * (marketplace/runtime-view.ts). Without this field the plugin would sit in the list
       * looking normal while quietly doing nothing — which §9 of the design calls the worst
       * state this feature can produce.
       */
      applyState: stored.applyState ? { status: stored.applyState.status, kind: stored.applyState.kind } : null,
      skills: pluginSkills,
      connectors,
    };
  });
}

/** Per-user mute of a whole shared plugin — hides every skill + connector it
 *  routed for this user only (the admin's global state is untouched). */
export async function setPluginMutedForUser(installId: string, userId: string, muted: boolean): Promise<void> {
  const tag = `catalog:${installId}`;
  const [sk, co] = await Promise.all([
    db.select({ id: skills.id }).from(skills).where(eq(skills.source, tag)),
    db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.source, tag)),
  ]);
  await Promise.all([
    ...sk.map((s) => setMuted(userId, "skill", s.id, muted)),
    ...co.map((c) => setMuted(userId, "mcp", c.id, muted)),
  ]);
}

/** Scope + owner of an install, for API ownership checks (a member may only act on
 *  their own personal install; system installs are admin-only). */
export async function getInstallOwner(installId: string): Promise<{ scope: string; userId: string | null; pluginName: string } | null> {
  const row = (await db.select({ scope: pluginInstalls.scope, userId: pluginInstalls.userId, pluginName: pluginInstalls.pluginName })
    .from(pluginInstalls).where(eq(pluginInstalls.id, installId)).limit(1))[0];
  return row ?? null;
}

/** Flip enabled on every skill + connector a plugin routed — one action for the
 *  whole group (the data model already filters runtime use by `enabled`).
 *
 *  A bulk update is fine here, unlike the deletes in install.ts: an `enabled` flip
 *  has no inverse to run beyond the column itself. Nothing reads a disabled row —
 *  `listEnabledServerConfigs` filters on it — so a cached tool schema left behind by
 *  a disable is never served, and is still valid if the plugin is re-enabled. */
export async function setPluginEnabled(installId: string, enabled: boolean): Promise<void> {
  const tag = `catalog:${installId}`;
  const now = new Date();
  await db.update(skills).set({ enabled, updatedAt: now }).where(eq(skills.source, tag));
  await db.update(mcpServers).set({ enabled, updatedAt: now }).where(eq(mcpServers.source, tag));
}

/** Whether this plugin is already installed org-wide (system). Used to stop a
 *  member from creating a redundant personal copy of something everyone has. */
export async function hasSystemInstall(marketplaceId: string, pluginName: string): Promise<boolean> {
  const r = await db.select({ id: pluginInstalls.id }).from(pluginInstalls).where(and(
    eq(pluginInstalls.marketplaceId, marketplaceId),
    eq(pluginInstalls.pluginName, pluginName),
    eq(pluginInstalls.scope, "system"),
  )).limit(1);
  return !!r[0];
}

/**
 * The install id for a (marketplace, plugin) **belonging to a specific owner**, or null.
 *
 * The owner is not optional, because a plugin no longer has ONE install: the schema's two
 * partial unique indexes deliberately allow one org-wide row plus a personal row per member
 * (`uq_plugin_installs_system` / `uq_plugin_installs_user`). Matching on
 * (marketplace, plugin) alone returned whichever row came back first — so a member asking to
 * install personally got handed the SYSTEM row and was refused as a non-admin, an admin's
 * upgrade could move somebody's personal pin, and an uninstall could delete a row nobody
 * named. The keys here are exactly the columns those indexes are unique over.
 */
export async function findInstall(
  marketplaceId: string,
  pluginName: string,
  owner: { scope: "system" | "user"; userId: string | null },
): Promise<string | null> {
  const r = await db.select({ id: pluginInstalls.id }).from(pluginInstalls).where(and(
    eq(pluginInstalls.marketplaceId, marketplaceId),
    eq(pluginInstalls.pluginName, pluginName),
    eq(pluginInstalls.scope, owner.scope),
    // `user_id IS NULL` for a system install, and `= NULL` is never true in SQL.
    owner.scope === "user" && owner.userId ? eq(pluginInstalls.userId, owner.userId) : isNull(pluginInstalls.userId),
  )).limit(1);
  return r[0]?.id ?? null;
}
