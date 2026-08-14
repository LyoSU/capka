import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { pluginInstalls, pluginMarketplaces } from "@/lib/db/schema";
import { ValidationError } from "@/lib/errors";
import { applyPluginReviewed, previewPluginApply, type ApplyOutcome } from "./barrier";
import { contentHash } from "./canonical";
import { ghFetch, resolveCommit } from "./fetch";
import { writeReviewedPlan } from "./install";
import { parseGitHubUrl } from "./source";
import type { PolicyDisposition, ReviewResponse } from "./review";
import type { DispositionActor, PolicyOutlook } from "./policy-disposition";
import type { CatalogItem, GitHubRef } from "./types";

/**
 * A bare GitHub skills repo — `skills/<name>/SKILL.md` with no `marketplace.json` — put
 * through the SAME review barrier as a marketplace plugin.
 *
 * Why this module exists rather than another `installPlugin` call: the chat-driven
 * `manage skill add {repo}` used to enumerate the repo with `discoverSkills` for its approval
 * card and then install it with `buildPluginPlan`. Two enumerators, and they disagreed —
 * `buildPluginPlan` also converts `commands/*.md` into skills, which the card never mentioned
 * (and which takes its NAME from the filename, bypassing the frontmatter check). So the card
 * listed what would be installed and the list was incomplete: it asserted something untrue
 * about its own outcome.
 *
 * Keeping two enumerators in step is the kind of promise a comment makes and code does not.
 * The card is therefore built from the REVIEW, which is built from `buildPluginPlan` — one
 * enumerator, by construction, and the apply is gated on the hash the card showed.
 */

/** The synthetic one-plugin catalog a bare repo is modelled as. Written at APPLY time only,
 *  because a preview must not create rows — but its ID has to be known before then. */
const catalogFor = (owner: string, name: string): CatalogItem[] => [{
  name, description: "", author: owner, category: null,
  homepage: null, kind: "plugin", source: ".", installable: true,
}];

/**
 * The identity the preview and the apply MUST agree on, derived rather than generated.
 *
 * `marketplaceId` is inside `reviewHash`. A `nanoid()` minted during the apply would differ
 * from whatever the preview assumed, so the hash could never match and every install would come
 * back `stale` — which is why the id is a function of the URL. An existing row keeps its own
 * id (installs predate this), so both sides look it up first and reach the same answer.
 */
export async function resolveSkillRepo(url: string): Promise<{
  marketplaceId: string;
  pluginName: string;
  gh: GitHubRef;
  /** Whether the synthetic marketplace row already exists. The apply creates it if not. */
  registered: boolean;
}> {
  const repo = parseGitHubUrl(url);
  if (!repo) throw new ValidationError("Only GitHub repositories are supported. Paste a github.com repo URL or owner/repo.");
  const clean = url.trim();
  const existing = (await db.select({ id: pluginMarketplaces.id }).from(pluginMarketplaces)
    .where(eq(pluginMarketplaces.url, clean)).limit(1))[0];
  return {
    marketplaceId: existing?.id ?? `skillrepo-${contentHash(clean).slice(0, 24)}`,
    pluginName: repo.repo,
    // `subdir: ""` — the repo root IS the plugin. `ref: "HEAD"` is only ever resolved to a
    // concrete commit before it reaches the barrier.
    gh: { owner: repo.owner, repo: repo.repo, ref: "HEAD", subdir: "" },
    registered: !!existing,
  };
}

/** The install this repo already has for this owner, or null. Read identically by both sides
 *  so they review the same subject — a first install and an upgrade hash differently. */
async function findOwnInstall(marketplaceId: string, pluginName: string, scope: "system" | "user", userId: string | null) {
  return (await db.select({ id: pluginInstalls.id, manifest: pluginInstalls.manifest }).from(pluginInstalls)
    .where(and(
      eq(pluginInstalls.marketplaceId, marketplaceId),
      eq(pluginInstalls.pluginName, pluginName),
      eq(pluginInstalls.scope, scope),
      scope === "user" && userId ? eq(pluginInstalls.userId, userId) : isNull(pluginInstalls.userId),
    )).limit(1))[0] ?? null;
}

export interface SkillRepoReview {
  review: ReviewResponse;
  policies: PolicyOutlook[];
  /** Both travel to the apply, which refuses without them. */
  targetSha: string;
  marketplaceId: string;
}

/**
 * Build the review for a bare skills repo. Touches nothing.
 *
 * `HEAD` is resolved to a concrete commit HERE, and that commit is what the apply must name —
 * otherwise a hostile upstream moves the branch between the card and the click.
 */
export async function previewSkillRepoInstall(input: {
  url: string;
  only?: string[];
  scope: "system" | "user";
  userId: string;
  actor: DispositionActor;
}): Promise<SkillRepoReview> {
  const { marketplaceId, pluginName, gh } = await resolveSkillRepo(input.url);
  const targetSha = (await resolveCommit(gh.owner, gh.repo, gh.ref, await ghFetch())).sha;
  const ownerId = input.scope === "user" ? input.userId : null;
  const own = await findOwnInstall(marketplaceId, pluginName, input.scope, ownerId);

  const { review, policies } = await previewPluginApply({
    gh: { ...gh, ref: targetSha },
    marketplaceId, pluginName, scope: input.scope, ownerId,
    installId: own?.id ?? null, targetSha,
    only: input.only?.length ? input.only : undefined,
    // The promise the approval card makes. In the hash, so an apply cannot widen it.
    skillsOnly: true,
    storedManifestRaw: own?.manifest,
    actor: input.actor,
  });
  return { review, policies, targetSha, marketplaceId };
}

/**
 * Apply exactly the review the card showed, through the barrier — claim, lease, second hash
 * check, fenced writes, lifecycle journal and all.
 *
 * The synthetic marketplace row is created here and not in the preview: `pluginInstalls`
 * carries an FK to it, so it has to exist before the barrier's staging insert, and a preview
 * that wrote rows would not be a preview.
 */
export async function applySkillRepoInstall(input: {
  url: string;
  only?: string[];
  scope: "system" | "user";
  userId: string;
  actor: DispositionActor;
  reviewHash: string;
  targetSha: string;
  dispositions?: Record<string, PolicyDisposition>;
}): Promise<ApplyOutcome> {
  const { marketplaceId, pluginName, gh, registered } = await resolveSkillRepo(input.url);
  if (!registered) {
    // `ON CONFLICT DO NOTHING`: two approvals of the same repo racing here is not a conflict
    // worth failing, since the id is derived and both would write the same row.
    await db.insert(pluginMarketplaces).values({
      id: marketplaceId, url: input.url.trim(), name: `${gh.owner}/${gh.repo}`,
      owner: gh.owner, catalog: catalogFor(gh.owner, pluginName),
      // Plumbing, not a catalog an admin chose to publish — kept out of the Browse list so a
      // member installing skills for themselves does not edit what the organization sees.
      synthetic: true, refreshedAt: new Date(),
    }).onConflictDoNothing();
  }
  const ownerId = input.scope === "user" ? input.userId : null;
  const own = await findOwnInstall(marketplaceId, pluginName, input.scope, ownerId);

  const outcome = await applyPluginReviewed({
    gh: { ...gh, ref: input.targetSha },
    marketplaceId, pluginName, scope: input.scope, ownerId,
    installId: own?.id ?? null, targetSha: input.targetSha,
    only: input.only?.length ? input.only : undefined,
    skillsOnly: true,
    actorId: input.userId,
    reviewHash: input.reviewHash,
    dispositions: input.dispositions ?? {},
    actor: input.actor,
    performWrites: ({ operationId, plan, observations, installId }) => writeReviewedPlan({
      operationId, installId, plan, observations,
      target: { scope: input.scope, userId: ownerId, projectId: null },
      priorManifest: own?.manifest,
      fallbackVersion: input.targetSha.slice(0, 7),
    }),
  });

  // The row exists only to be an install's parent, so an apply that installed NOTHING leaves
  // it with no reason to exist — a `stale` hash, a `blocked` gate or a claim that could not be
  // written all end here. It has to be created before the barrier (the FK is checked by the
  // staging insert) rather than inside its transaction, so the undo lives beside the create
  // instead: only when we are the ones who created it, and only while nothing points at it,
  // which is what keeps a racing second install's row from being deleted out from under it.
  if (!registered && outcome.outcome !== "succeeded") {
    const [stillEmpty] = await db.select({ id: pluginInstalls.id }).from(pluginInstalls)
      .where(eq(pluginInstalls.marketplaceId, marketplaceId)).limit(1);
    if (!stillEmpty) {
      await db.delete(pluginMarketplaces)
        .where(and(eq(pluginMarketplaces.id, marketplaceId), eq(pluginMarketplaces.synthetic, true)));
    }
  }
  return outcome;
}

/** The skill names an accepted review will actually install — read off the review itself, so
 *  the card cannot enumerate a different set from the one that lands. */
export function reviewedSkillNames(review: ReviewResponse): string[] {
  return review.surface.skills.map((s) => s.name);
}

/** Whether the committed rows this apply would overwrite were edited outside the installer.
 *  The card has to say so before overwriting somebody's hand edit. */
export function hasLocalEdits(review: ReviewResponse): boolean {
  return review.delta.effective.some((e) => e.kind === "replacement" || e.kind === "unknown");
}

/**
 * Permission rules this apply would leave pointing at nothing.
 *
 * A chat card is the wrong place to DECIDE about a permission rule — there is no room to show
 * what the rule does, and getting it wrong is not recoverable from the card. So the card names
 * them and the apply keeps them: `dispositions` stays empty on this path, which is the
 * conservative outcome (a kept rule is a standing rule for a future resource of that name).
 * Deleting one is done deliberately in Settings, where the rule can be read.
 */
export function orphanedPolicyKeys(policies: PolicyOutlook[]): string[] {
  return policies.filter((p) => p.outlook === "applies_to_nothing").map((p) => p.capabilityKey);
}
