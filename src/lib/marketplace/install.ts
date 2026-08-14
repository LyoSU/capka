import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls, pluginMarketplaces, pluginFiles, skills, mcpServers } from "@/lib/db/schema";
import { deleteSkill } from "@/lib/skills/service";
import { deleteServer } from "@/lib/mcp/service";
import { getMasterKey } from "@/lib/settings";
import { parseGitHubUrl, resolveGitHub } from "./source";
import { ghFetch, ghTree, diffTrees, resolveCommit, type TreeDiff } from "./fetch";
import { applyPlanResources } from "./apply";
import { FencedWriteError, MANUAL, acquireFence, type MutationAuthority } from "./fence";
import { readStoredManifest, writeStoredManifest } from "./manifest-store";
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

/** What moving an install's pin would change, computed WITHOUT touching the DB so an
 *  operator can review (informed consent) before it happens. `changed:false`
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
 * `installPlugin` and `installSkillRepo` used to live here, and their deletion completes what
 * removing `upgradePlugin` started: there is now exactly ONE writer that routes a plugin's
 * resources, and it is `writeReviewedPlan` under an operation claim.
 *
 * They were the last unreviewed path to these rows. `installPlugin` had already been narrowed
 * (fenced, skills-only for a repo, its row reserved before anything was routed) so it could no
 * longer corrupt a concurrent apply — but it remained a second CONSENT surface: no reviewHash,
 * no claim, no lifecycle journal, no "locally modified" warning before it overwrote a
 * hand-edited skill, and no orphaned-permission analysis. Their only caller was the chat-driven
 * `manage skill add {repo}`, which now goes through `marketplace/skill-repo.ts` and the barrier.
 *
 * Deleting rather than leaving them unused is the point. Twice in this feature a live writer
 * with no caller turned out to be reachable after all, and both times that is what made the
 * consent gate optional. An unreachable path cannot be reached by mistake.
 *
 * `uninstallPlugin` below is deliberately NOT one of them: removing everything an install
 * routed needs no review, and it is the inverse the two API routes still call.
 */

/** Remove everything an install routed (FK cascade drops skill files, plugin
 *  files + oauth rows when the pluginInstalls row goes). */
export async function uninstallPlugin(installId: string): Promise<void> {
  const tag = `catalog:${installId}`;
  // An uninstall is a prune that keeps nothing — same routing, so a connector's
  // cached schemas go with it here too.
  await pruneRemoved(tag, new Set(), new Set());
  await db.delete(pluginInstalls).where(eq(pluginInstalls.id, installId));
}
