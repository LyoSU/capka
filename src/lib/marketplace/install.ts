import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls, pluginMarketplaces, pluginFiles, skills, mcpServers } from "@/lib/db/schema";
import { ingestSkill, deleteSkill } from "@/lib/skills/service";
import { upsertServer, upsertStdioServer, setEnabled, deleteServer } from "@/lib/mcp/service";
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import { ValidationError } from "@/lib/errors";
import { parseGitHubUrl, resolveGitHub } from "./source";
import { ghFetch, ghTree, diffTrees, resolveCommit, type TreeDiff } from "./fetch";
import { buildPluginPlan } from "./plan";
import type { CatalogItem, CommitInfo, GitHubRef, InstallManifest } from "./types";

// A pin is a full 40-hex commit SHA. Anything else (a branch/tag/"HEAD") would
// re-dereference to live upstream HEAD at apply time and defeat the review.
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Where a plugin's skills + connectors are routed: org-wide (system) or personal
 *  (user). A member install is `{ scope: "user", userId: <them> }`. */
interface InstallTarget { scope: "system" | "user"; userId: string | null; projectId: string | null }

/** What a single plugin pull produced: the public manifest + the bundled files to
 *  persist for runtime materialization (kept out of the manifest JSON, which is
 *  small + user-facing). */
interface ApplyResult { manifest: InstallManifest; files: { path: string; content: string }[] }

/**
 * Delete the skills/connectors this install owns that `keep*` no longer names —
 * upstream removals on an upgrade, or EVERYTHING on an uninstall (empty sets).
 * Keyed by the install tag.
 *
 * Deletes through each service instead of issuing its own `db.delete`: a service
 * owns the inverse of whatever its upsert installed BEYOND the row itself, and
 * `deleteServer` also drops the connector's cached tool schemas. A bulk delete here
 * skips that silently, leaving the in-process schema cache holding an entry for a
 * connector that no longer exists — the map documents itself as holding one entry
 * per EXISTING connector, and an upgrade ran this on every removal.
 *
 * Exported so the routing itself can be asserted: the regression this prevents is
 * invisible in the DB, which is why it survived unnoticed.
 */
export async function pruneRemoved(tag: string, keepSkills: Set<string>, keepConnectors: Set<string>): Promise<void> {
  const ownedSkills = await db.select({ id: skills.id, name: skills.name }).from(skills).where(eq(skills.source, tag));
  for (const s of ownedSkills) {
    if (!keepSkills.has(s.name)) await deleteSkill(s.id);
  }
  const ownedConnectors = await db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.source, tag));
  for (const c of ownedConnectors) {
    if (!keepConnectors.has(c.name)) await deleteServer(c.id);
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
/** Exported ONLY for the characterization suite that guards the Phase A split
 *  (docs/plugin-install-review-plan-phase-a.md). Deleted in Task 5 along with the
 *  function itself — no production caller outside this module. */
export async function applyPlugin(gh: GitHubRef, tag: string, target: InstallTarget, only?: string[]): Promise<ApplyResult> {
  const plan = await buildPluginPlan(gh, only);
  const manifest: InstallManifest = {
    skills: [], connectors: [], ignored: plan.ignored, notes: plan.notes, commit: plan.commit,
    ...(plan.version ? { version: plan.version } : {}),
    ...(plan.displayName ? { displayName: plan.displayName } : {}),
  };

  for (const c of plan.connectors) {
    if (c.kind === "stdio") {
      // Every marketplace stdio server runs third-party code in a user's sandbox, so
      // all of them install OFF and an admin enables them from Extensions.
      const sid = await upsertStdioServer({ ...target, name: c.name, command: c.command!, args: c.args, env: c.env, source: tag });
      await setEnabled(sid, false);
    } else {
      let authKind: "token" | "oauth" = "token";
      try { authKind = await detectAuthKind(c.url!); } catch { /* default token */ }
      const secrets = c.headers && !c.hasPlaceholder ? { headers: c.headers } : undefined;
      const id = await upsertServer({ ...target, name: c.name, url: c.url!, secrets, authKind, source: tag });
      if (c.hasPlaceholder) await setEnabled(id, false);
    }
    manifest.connectors.push(c.name);
  }

  for (const s of plan.skills) {
    await ingestSkill(s.parsed, s.files, { ...target, source: tag });
    manifest.skills.push(s.name);
  }

  return { manifest, files: plan.files };
}

/** Install one plugin from an added marketplace into A (skills) + B (connectors),
 *  tagging every routed row `catalog:<installId>` for clean uninstall. */
export async function installPlugin(opts: {
  marketplaceId: string;
  pluginName: string;
  installedBy: string;
  /** Org-wide (admin) or personal (a member installing for themselves). */
  scope?: "system" | "user";
  /** Narrow to specific skills by name (`--skill`); omit for all. */
  only?: string[];
  /** Pin a FIRST install to a specific reviewed commit (from the pre-install
   *  preview) instead of live HEAD — closes the preview→apply TOCTOU. Ignored on
   *  re-install, which stays on its already-pinned commit (moving the pin is an
   *  explicit upgrade). */
  pinSha?: string;
}): Promise<InstallManifest> {
  const { gh } = await resolvePlugin(opts.marketplaceId, opts.pluginName);
  const scope = opts.scope ?? "system";
  const ownerId = scope === "user" ? opts.installedBy : null;
  const target: InstallTarget = { scope, userId: ownerId, projectId: null };

  // Idempotent per (marketplace, plugin, owner): re-installing reuses the same
  // install row + tag instead of duplicating. A member's personal install is
  // distinct from the org-wide one (matched by scope + userId).
  const existing = (await db.select({ id: pluginInstalls.id, commitSha: pluginInstalls.commitSha }).from(pluginInstalls)
    .where(and(
      eq(pluginInstalls.marketplaceId, opts.marketplaceId),
      eq(pluginInstalls.pluginName, opts.pluginName),
      eq(pluginInstalls.scope, scope),
      ownerId ? eq(pluginInstalls.userId, ownerId) : isNull(pluginInstalls.userId),
    )).limit(1))[0];
  const installId = existing?.id ?? nanoid();
  // Re-install stays PINNED: re-pull the commit already installed, not whatever the
  // branch points at now. A first install uses the reviewed commit from the preview
  // (`pinSha`) when present, else live HEAD (`gh.ref`). Moving the pin is an explicit
  // upgrade (with a diff).
  const ref = existing?.commitSha || opts.pinSha || gh.ref;
  const { manifest, files } = await applyPlugin({ ...gh, ref }, `catalog:${installId}`, target, opts.only);

  if (existing) {
    // re-install: drop rows removed upstream
    await pruneRemoved(`catalog:${installId}`, new Set(manifest.skills), new Set(manifest.connectors));
    await db.update(pluginInstalls)
      .set({ version: manifest.version ?? gh.ref, commitSha: manifest.commit?.sha ?? existing.commitSha, manifest: manifest as unknown as Record<string, unknown> })
      .where(eq(pluginInstalls.id, installId));
  } else {
    // Insert the install row before its files (pluginFiles FK → pluginInstalls).
    await db.insert(pluginInstalls).values({
      id: installId, marketplaceId: opts.marketplaceId, pluginName: opts.pluginName,
      version: manifest.version ?? gh.ref, commitSha: manifest.commit?.sha ?? null, scope, userId: ownerId,
      manifest: manifest as unknown as Record<string, unknown>, installedBy: opts.installedBy,
    });
  }
  await persistPluginFiles(installId, files);
  return manifest;
}

/** What `upgradePlugin` would change, computed WITHOUT touching the DB so an
 *  operator can review (informed consent) before moving the pin. `changed:false`
 *  means the pinned commit is already the latest. */
export interface UpgradePreview {
  changed: boolean;
  fromSha: string | null;
  to: CommitInfo;
  diff?: TreeDiff;
  /** A connector DEFINITION file (.mcp.json / plugin.json) was added or changed —
   *  the highest-signal warning, since it can introduce code that runs in the sandbox. */
  touchesConnectors?: boolean;
}

/** Resolve what an upgrade would do without applying it: the target commit and,
 *  if it differs from the pin, the file-level diff between the two trees. */
export async function previewUpgrade(installId: string): Promise<UpgradePreview> {
  const row = (await db.select().from(pluginInstalls).where(eq(pluginInstalls.id, installId)).limit(1))[0];
  if (!row) throw new Error("Install not found");
  // A legacy install with no pin has no baseline to diff against — a diff would read
  // as "everything added", a fake review. Refuse the in-place upgrade and steer the
  // user to re-install, which establishes a concrete, reviewable pin (commitSha).
  if (!row.commitSha) {
    throw new Error("This plugin was installed before pinning and has no reviewable baseline. Uninstall and re-install it to establish a pinned version before upgrading.");
  }
  const { gh } = await resolvePlugin(row.marketplaceId, row.pluginName);
  const fetchFn = await ghFetch();
  const to = await resolveCommit(gh.owner, gh.repo, gh.ref, fetchFn);
  if (to.sha === row.commitSha) return { changed: false, fromSha: row.commitSha, to };

  const prefix = gh.subdir ? `${gh.subdir}/` : "";
  const [oldTree, newTree] = await Promise.all([
    ghTree(gh.owner, gh.repo, row.commitSha, fetchFn),
    ghTree(gh.owner, gh.repo, to.sha, fetchFn),
  ]);
  const diff = diffTrees(oldTree, newTree, prefix);
  const touchesConnectors = [...diff.added, ...diff.modified, ...diff.removed].some(
    (p) => p === ".mcp.json" || p.endsWith("/.mcp.json") || p.endsWith("plugin.json"),
  );
  return { changed: true, fromSha: row.commitSha, to, diff, touchesConnectors };
}

/** Re-pull an installed plugin from its source, keeping the same installId/tag so
 *  rows update in place. Skills/connectors removed upstream are pruned; the
 *  pluginInstalls row gets the fresh version + manifest.
 *
 *  FAIL-CLOSED on consent: an upgrade MUST target a specific reviewed commit
 *  (`toSha`). The UI previews that commit via previewUpgrade, then passes its SHA
 *  here so we apply EXACTLY what was reviewed — never whatever the branch points at
 *  by the time "Apply" runs (a hostile upstream could otherwise swap in a new
 *  commit between review and apply). The no-review "just re-pull what's installed"
 *  need is served by installPlugin, which stays on the already-pinned commit. */
export async function upgradePlugin(installId: string, toSha: string): Promise<InstallManifest> {
  // Must be a full commit SHA, not a branch/tag/"HEAD" — those re-dereference to
  // live upstream HEAD and would defeat the review.
  if (!FULL_SHA.test(toSha)) throw new Error("upgradePlugin requires the reviewed commit SHA (toSha): a full 40-character hex commit SHA");
  const row = (await db.select().from(pluginInstalls).where(eq(pluginInstalls.id, installId)).limit(1))[0];
  if (!row) throw new Error("Install not found");
  const { gh } = await resolvePlugin(row.marketplaceId, row.pluginName);
  const tag = `catalog:${installId}`;
  // Re-route into the same scope/owner the install already has.
  const target: InstallTarget = { scope: row.scope === "user" ? "user" : "system", userId: row.userId, projectId: null };

  // Bind apply to the EXACT reviewed commit. Resolve toSha and assert GitHub returns
  // the same SHA — a 40-hex value that is actually a (movable) lightweight tag would
  // resolve to a different commit, and we refuse rather than pin to drifted content.
  const fetchFn = await ghFetch();
  const resolved = await resolveCommit(gh.owner, gh.repo, toSha, fetchFn);
  if (resolved.sha !== toSha) throw new Error(`Reviewed commit ${toSha} no longer resolves to itself (got ${resolved.sha}); re-review before upgrading`);

  // Apply (and pin to) EXACTLY the reviewed commit.
  const { manifest, files } = await applyPlugin({ ...gh, ref: toSha }, tag, target);
  await persistPluginFiles(installId, files);
  await pruneRemoved(tag, new Set(manifest.skills), new Set(manifest.connectors));

  await db.update(pluginInstalls)
    .set({ version: manifest.version ?? gh.ref, commitSha: manifest.commit?.sha ?? row.commitSha, manifest: manifest as unknown as Record<string, unknown> })
    .where(eq(pluginInstalls.id, installId));
  return manifest;
}

/** Install skills straight from a git repo with no marketplace.json — a plain
 *  `skills/<name>/SKILL.md` collection, à la `npx skills add owner/repo`. The repo
 *  is modelled as a single-plugin marketplace whose one plugin (source ".") is the
 *  repo root, so installing it enumerates every skill — and the whole pin / upgrade
 *  / uninstall / Extensions machinery is reused unchanged. `only` narrows to
 *  specific skills (`--skill`). The synthetic marketplace row is reused per URL. */
export async function installSkillRepo(opts: {
  url: string;
  installedBy: string;
  scope?: "system" | "user";
  only?: string[];
  /** Reviewed commit from the pre-install preview — pins a first install to it (TOCTOU). */
  sha?: string;
}): Promise<InstallManifest> {
  const repo = parseGitHubUrl(opts.url);
  if (!repo) throw new ValidationError("Only GitHub repositories are supported. Paste a github.com repo URL.");
  const clean = opts.url.trim();
  const pluginName = repo.repo;
  const existing = (await db.select({ id: pluginMarketplaces.id }).from(pluginMarketplaces).where(eq(pluginMarketplaces.url, clean)).limit(1))[0];
  let marketplaceId = existing?.id;
  if (!marketplaceId) {
    marketplaceId = nanoid();
    const catalog: CatalogItem[] = [{
      name: pluginName, description: "", author: repo.owner, category: null,
      homepage: null, kind: "plugin", source: ".", installable: true,
    }];
    await db.insert(pluginMarketplaces).values({
      id: marketplaceId, url: clean, name: `${repo.owner}/${repo.repo}`, owner: repo.owner, catalog, refreshedAt: new Date(),
    });
  }
  return installPlugin({ marketplaceId, pluginName, installedBy: opts.installedBy, scope: opts.scope, only: opts.only, pinSha: opts.sha });
}

/** Remove everything an install routed (FK cascade drops skill files, plugin
 *  files + oauth rows when the pluginInstalls row goes). */
export async function uninstallPlugin(installId: string): Promise<void> {
  const tag = `catalog:${installId}`;
  // An uninstall is a prune that keeps nothing — same routing, so a connector's
  // cached schemas go with it here too.
  await pruneRemoved(tag, new Set(), new Set());
  await db.delete(pluginInstalls).where(eq(pluginInstalls.id, installId));
}
