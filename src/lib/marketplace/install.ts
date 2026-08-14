import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls, pluginMarketplaces, pluginFiles, skills, mcpServers } from "@/lib/db/schema";
import { deleteSkill } from "@/lib/skills/service";
import { deleteServer } from "@/lib/mcp/service";
import { ValidationError } from "@/lib/errors";
import { getBlockPrivateProviderUrls, getMasterKey } from "@/lib/settings";
import { parseGitHubUrl, resolveGitHub } from "./source";
import { ghFetch, ghTree, diffTrees, resolveCommit, type TreeDiff } from "./fetch";
import { applyPlanResources } from "./apply";
import { FencedWriteError, MANUAL, acquireFence, type MutationAuthority } from "./fence";
import { observePluginPlan } from "./observe";
import { readStoredManifest, reservedManifest, writeStoredManifest } from "./manifest-store";
import { buildPluginPlan } from "./plan";
import { projectPlanSurface } from "./project";
import type { ReviewObservations } from "./observe";
import type { ResolvedPluginPlan } from "./plan";
import type { CatalogItem, CommitInfo, InstallManifest } from "./types";


/** Where a plugin's skills + connectors are routed: org-wide (system) or personal
 *  (user). A member install is `{ scope: "user", userId: <them> }`. */
interface InstallTarget { scope: "system" | "user"; userId: string | null; projectId: string | null }

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
export async function pruneRemoved(
  tag: string,
  keepSkills: Set<string>,
  keepConnectors: Set<string>,
  authority: MutationAuthority = MANUAL,
): Promise<void> {
  const ownedSkills = await db.select({ id: skills.id, name: skills.name }).from(skills).where(eq(skills.source, tag));
  for (const s of ownedSkills) {
    if (keepSkills.has(s.name)) continue;
    // A prune is idempotent, so `missing` IS success — the row is already gone, which is
    // what was wanted. `fenced` never is: it means this operation no longer owns the
    // install, and continuing would delete resources on behalf of a claim someone else
    // holds. That distinction is exactly why these writers return an outcome and not a
    // boolean.
    if (await deleteSkill(s.id, authority) === "fenced") throw new FencedWriteError(`skill ${s.name}`);
  }
  const ownedConnectors = await db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.source, tag));
  for (const c of ownedConnectors) {
    if (keepConnectors.has(c.name)) continue;
    if (await deleteServer(c.id, authority) === "fenced") throw new FencedWriteError(`connector ${c.name}`);
  }
}

/**
 * The committed manifest value for a finished apply: the inventory the UI reads plus
 * the surface the NEXT upgrade compares against, under one revision counter.
 *
 * Built here rather than at each write site so the two callers cannot disagree about
 * where a field lives or forget to bump the counter — the counter is what a later
 * claim's CAS compares, so a missed bump would let a stale apply win
 * (docs/plugin-install-review-spec.md §4, §7).
 */
async function committedManifest(
  plan: ResolvedPluginPlan,
  obs: ReviewObservations,
  inventory: InstallManifest,
  priorManifest: unknown,
): Promise<Record<string, unknown>> {
  const prior = readStoredManifest(priorManifest);
  const surface = projectPlanSurface(plan, obs, await getMasterKey());
  // A legacy row reads as 0 and becomes 1 here — the lazy upgrade, with no backfill.
  // A CORRUPT V2 row reads as NaN and stays NaN, so `writeStoredManifest` refuses: an
  // apply that silently renumbered a row whose counter went missing would repair the
  // symptom and destroy the evidence.
  return writeStoredManifest({
    inventory,
    installSurface: surface,
    committedRevision: prior.committedRevision + 1,
  }) as unknown as Record<string, unknown>;
}

/**
 * Replace the bundled-file set for an install, FENCED and atomic.
 *
 * These bytes are the ones that actually run: `plugin-runtime.ts` materializes them into the
 * sandbox and `chmod +x`es the entrypoint. Fencing the parent rows and leaving this
 * unconditional produced a real race — A loses its lease, B applies and finalizes a safe
 * version, A then wakes up and overwrites the FILES while the install already reads `ready`.
 * The row said B, the sandbox ran A.
 *
 * So: one transaction, holding the fence on the owning install for its whole length. That
 * lock is what makes it airtight rather than a re-check — the reaper, a rival claim,
 * `markApplyFailed` and `finalizeApply` are all UPDATEs on that row and block until commit,
 * so the lease cannot lapse between the check and the last insert. A dispossessed worker is
 * refused and writes nothing.
 *
 * The row's own columns ride in the same transaction for the same reason: keyed only by
 * install id, they were unfenced writes a dispossessed worker could land. `manifest`
 * especially — `applyState` lives inside that column, so an unconditional overwrite of it
 * ERASED a concurrent reviewed apply's claim, and that operation's finalize then failed on a
 * row it still legitimately owned.
 */
async function persistPluginFilesFenced(args: {
  installId: string;
  files: { path: string; content: string }[];
  authority: MutationAuthority;
  /** Written in the SAME transaction when given. `writeReviewedPlan` omits `manifest`,
   *  because `finalizeApply` is what publishes that — under its own CAS. */
  metadata?: { version: string; commitSha: string | null; manifest?: Record<string, unknown> };
}): Promise<void> {
  await db.transaction(async (tx) => {
    if (!await acquireFence(tx, args.authority, `catalog:${args.installId}`)) {
      throw new FencedWriteError(`bundled files for install ${args.installId}`);
    }
    await tx.delete(pluginFiles).where(eq(pluginFiles.installId, args.installId));
    if (args.files.length) {
      await tx.insert(pluginFiles).values(
        args.files.map((f) => ({ id: nanoid(), installId: args.installId, path: f.path, content: f.content })));
    }
    if (args.metadata) await tx.update(pluginInstalls).set(args.metadata).where(eq(pluginInstalls.id, args.installId));
  });
}

/**
 * Route a reviewed plan into rows, under the authority of a live operation.
 *
 * This is the `performWrites` the barrier drives, and everything it does carries
 * `{ kind: "plugin-apply", operationId }` — so if the operation loses its lease part-way,
 * the next write is `fenced` and the whole apply fails instead of half-landing under a
 * claim someone else now holds.
 *
 * The bundled files come before the prune for the same reason install has always done it:
 * a file set replaced after a prune could reference a resource the prune just removed.
 */
export async function writeReviewedPlan(args: {
  operationId: string;
  installId: string;
  plan: ResolvedPluginPlan;
  observations: ReviewObservations;
  target: InstallTarget;
  priorManifest: unknown;
  fallbackVersion: string;
}): Promise<Record<string, unknown>> {
  const authority: MutationAuthority = { kind: "plugin-apply", operationId: args.operationId };
  const tag = `catalog:${args.installId}`;
  const manifest = await applyPlanResources(args.plan, args.observations, tag, args.target, authority);
  await persistPluginFilesFenced({
    installId: args.installId,
    files: args.plan.files,
    authority,
    metadata: { version: manifest.version ?? args.fallbackVersion, commitSha: manifest.commit?.sha ?? null },
  });
  await pruneRemoved(tag, new Set(manifest.skills), new Set(manifest.connectors), authority);
  // Returned rather than written: `finalizeApply` publishes it, so until the claim is
  // resolved the runtime still sees the previous committed view.
  return committedManifest(args.plan, args.observations, manifest, args.priorManifest);
}

/** Resolve a (marketplace, plugin) to its GitHub location + catalog entry. Exported so the
 *  review flow resolves the SAME location the apply will use — two resolvers could disagree
 *  about which commit is being reviewed. */
export async function resolvePlugin(marketplaceId: string, pluginName: string) {
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

/** Install one plugin from an added marketplace into A (skills) + B (connectors),
 *  tagging every routed row `catalog:<installId>` for clean uninstall. Idempotent per
 *  name: ingestSkill / upsertServer upsert by name, so re-running with the same tag
 *  updates in place — the basis of upgrade. */
export async function installPlugin(opts: {
  marketplaceId: string;
  pluginName: string;
  installedBy: string;
  /** Org-wide (admin) or personal (a member installing for themselves). */
  scope?: "system" | "user";
  /** Narrow to specific skills by name (`--skill`); omit for all. */
  only?: string[];
  /** Route ONLY skills, whatever else the repo declares — what `installSkillRepo`'s
   *  approval card promises. */
  skillsOnly?: boolean;
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
  const existing = (await db.select({ id: pluginInstalls.id, commitSha: pluginInstalls.commitSha, manifest: pluginInstalls.manifest }).from(pluginInstalls)
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

  // Reserve the row BEFORE routing a single resource.
  //
  // Routing first and inserting afterwards meant two concurrent first installs of the same
  // plugin each wrote skills and connectors tagged with their OWN `catalog:<id>`, and then only
  // one insert survived the partial unique index. The loser's rows were left owned by an
  // install row that does not exist — invisible to `uninstallPlugin`, skipped by every prune,
  // and reachable from no screen. Claiming the identity first turns that race into a refused
  // insert before anything is written.
  if (!existing) {
    await db.insert(pluginInstalls).values({
      id: installId, marketplaceId: opts.marketplaceId, pluginName: opts.pluginName,
      version: ref, commitSha: null, scope, userId: ownerId, installedBy: opts.installedBy,
      manifest: reservedManifest() as unknown as Record<string, unknown>,
    });
  }

  try {
    const plan = await buildPluginPlan({ ...gh, ref }, { only: opts.only, skillsOnly: opts.skillsOnly });
    const obs = await observePluginPlan(plan, { blockPrivate: await getBlockPrivateProviderUrls() });
    const manifest = await applyPlanResources(plan, obs, `catalog:${installId}`, target, MANUAL);
    const stored = await committedManifest(plan, obs, manifest, existing?.manifest);

    // The pin, the manifest and the bundled files in ONE FENCED transaction. All three used to
    // be unconditional writes keyed by install id alone, and `manifest` is the one that hurt:
    // `applyState` lives inside that column, so this path could erase a reviewed apply's live
    // claim — after which that operation's `finalizeApply` failed on a row it still owned, and
    // the plugin was left `failed` for a reason nothing recorded.
    //
    // MANUAL authority, which is the point: the fence refuses outright while any apply is in
    // flight on this install.
    await persistPluginFilesFenced({
      installId, files: plan.files, authority: MANUAL,
      metadata: {
        version: manifest.version ?? gh.ref,
        commitSha: manifest.commit?.sha ?? existing?.commitSha ?? null,
        manifest: stored,
      },
    });
    // After the files, exactly as `writeReviewedPlan` orders it: a file set replaced after a
    // prune could reference a resource the prune had just removed.
    await pruneRemoved(`catalog:${installId}`, new Set(manifest.skills), new Set(manifest.connectors));
    return manifest;
  } catch (e) {
    // Undo OUR reservation, and only ours. Leaving it would put an install in Extensions with
    // no resources and no explanation — the reservation exists to close a race, not to
    // outlive the install it was reserving for. An existing row predates this call and its
    // resources are still real, so it is left exactly as it was.
    if (!existing) await uninstallPlugin(installId);
    throw e;
  }
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

/*
 * `upgradePlugin` used to live here, and its deletion is the fix rather than a cleanup.
 *
 * It was the second unfenced writer: an unconditional
 * `db.update(pluginInstalls).set({ manifest })` that would overwrite a reviewed apply's live
 * `applyState`, with no claim, no lease and no transaction spanning its resource writes. Its
 * only caller was `POST /api/extensions`, which now returns 410 — every upgrade goes through
 * `writeReviewedPlan` under an operation claim. Leaving a reachable second path to the same
 * rows is exactly what made the consent gate optional the first time, so the path is gone
 * instead of merely being unused.
 */

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
  // `skillsOnly`, and it is load-bearing: the manage approval card for this enumerates the
  // SKILLS it found, so routing a `.mcp.json` connector or bundled plugin files off the same
  // repo would apply a larger set of capabilities than the human agreed to. A repo that
  // declares connectors is still installable — its skills land and `plan.notes` says the
  // connectors did not, which is reviewable, rather than silent either way.
  return installPlugin({
    marketplaceId, pluginName, installedBy: opts.installedBy, scope: opts.scope,
    only: opts.only, skillsOnly: true, pinSha: opts.sha,
  });
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
