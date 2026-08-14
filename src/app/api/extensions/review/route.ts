import { apiHandler, requireSession } from "@/lib/auth";
import { audit } from "@/lib/governance/audit";
import { applyPluginReviewed, previewPluginApply } from "@/lib/marketplace/barrier";
import { resolvePlugin, writeReviewedPlan } from "@/lib/marketplace/install";
import { findInstall } from "@/lib/marketplace/service";
import type { PolicyDisposition } from "@/lib/marketplace/review";
import { ghFetch, resolveCommit } from "@/lib/marketplace/fetch";
import { db } from "@/lib/db";
import { pluginInstalls } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { guardRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * The install review and its accept (docs/plugin-install-review-spec.md §7, §9).
 *
 * GET builds the review; POST applies exactly what was reviewed. They are one route
 * because they must resolve the plugin's location the same way — two resolvers could
 * disagree about which commit is under review.
 */

const FULL_SHA = /^[0-9a-f]{40}$/;

type Resolved =
  | { ok: true; installId: string | null; marketplaceId: string; pluginName: string; scope: "system" | "user"; ownerId: string | null; manifest: unknown }
  | { ok: false; status: number; error: string };

/**
 * Identify the subject and decide who may act on it — an admin for an org-wide install, the
 * owner for a personal one.
 *
 * An UPGRADE is identified by `installId` alone: the row already says which marketplace,
 * plugin, scope and owner it belongs to, and re-deriving those from the request would let a
 * caller ask about one install while naming another. A FIRST install has no row, so it is
 * identified by `(marketplaceId, pluginName, scope)`, and the scope being ASKED FOR is what
 * gets checked — a member may only ever ask for `user` scope, for themselves.
 */
async function resolveSubject(input: {
  userId: string; role: string;
  installId: string | null; marketplaceId: string | null; pluginName: string | null; scope: "system" | "user";
}): Promise<Resolved> {
  const installId = input.installId
    ?? (input.marketplaceId && input.pluginName ? await findInstall(input.marketplaceId, input.pluginName) : null);

  if (installId) {
    const row = (await db.select({
      marketplaceId: pluginInstalls.marketplaceId, pluginName: pluginInstalls.pluginName,
      scope: pluginInstalls.scope, userId: pluginInstalls.userId, manifest: pluginInstalls.manifest,
    }).from(pluginInstalls).where(eq(pluginInstalls.id, installId)).limit(1))[0];
    if (!row) return { ok: false, status: 404, error: "Not found" };
    const canManage = row.scope === "user" ? row.userId === input.userId : input.role === "admin";
    if (!canManage) return { ok: false, status: 403, error: "Not allowed" };
    return {
      ok: true, installId, marketplaceId: row.marketplaceId, pluginName: row.pluginName,
      scope: row.scope === "user" ? "user" : "system", ownerId: row.userId, manifest: row.manifest,
    };
  }

  if (!input.marketplaceId || !input.pluginName) {
    return { ok: false, status: 400, error: "installId, or marketplaceId and pluginName, required" };
  }
  if (input.scope === "system" && input.role !== "admin") {
    return { ok: false, status: 403, error: "Only an admin can install for everyone" };
  }
  return {
    ok: true, installId: null, marketplaceId: input.marketplaceId, pluginName: input.pluginName,
    scope: input.scope, ownerId: input.scope === "user" ? input.userId : null, manifest: undefined,
  };
}

/** The commit under review. Given explicitly it must be a full SHA — a movable tag would
 *  re-dereference at apply time and defeat the whole review. */
async function resolveTarget(gh: { owner: string; repo: string; ref: string }, requested: string | null): Promise<string> {
  if (requested) {
    if (!FULL_SHA.test(requested)) throw new Error("targetSha must be a full 40-character commit SHA");
    const resolved = await resolveCommit(gh.owner, gh.repo, requested, await ghFetch());
    if (resolved.sha !== requested) {
      throw new Error(`${requested} no longer resolves to itself (got ${resolved.sha}); re-review before applying`);
    }
    return requested;
  }
  return (await resolveCommit(gh.owner, gh.repo, gh.ref, await ghFetch())).sha;
}

export const GET = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const url = new URL(req.url);
  const subject = await resolveSubject({
    userId, role,
    installId: url.searchParams.get("installId"),
    marketplaceId: url.searchParams.get("marketplaceId"),
    pluginName: url.searchParams.get("pluginName"),
    scope: url.searchParams.get("scope") === "user" ? "user" : "system",
  });
  if (!subject.ok) return Response.json({ error: subject.error }, { status: subject.status });

  const { gh } = await resolvePlugin(subject.marketplaceId, subject.pluginName);
  const targetSha = await resolveTarget(gh, url.searchParams.get("targetSha"));

  const { review, policies } = await previewPluginApply({
    gh: { ...gh, ref: targetSha },
    marketplaceId: subject.marketplaceId, pluginName: subject.pluginName,
    scope: subject.scope, ownerId: subject.ownerId,
    installId: subject.installId, targetSha, storedManifestRaw: subject.manifest,
  });
  return Response.json({ review, policies, targetSha });
});

export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const limited = guardRateLimit(
    `extension-mutation:${userId}`,
    RATE_LIMITS.extensionMutation,
    "Too many extension requests — please wait before trying again.",
  );
  if (limited) return limited;

  const body = await req.json() as {
    installId?: unknown; marketplaceId?: unknown; pluginName?: unknown; scope?: unknown;
    targetSha?: unknown; reviewHash?: unknown; dispositions?: unknown; only?: unknown;
  };
  if (typeof body.reviewHash !== "string") {
    return Response.json({ error: "reviewHash required" }, { status: 400 });
  }
  const subject = await resolveSubject({
    userId, role,
    installId: typeof body.installId === "string" ? body.installId : null,
    marketplaceId: typeof body.marketplaceId === "string" ? body.marketplaceId : null,
    pluginName: typeof body.pluginName === "string" ? body.pluginName : null,
    scope: body.scope === "user" ? "user" : "system",
  });
  if (!subject.ok) return Response.json({ error: subject.error }, { status: subject.status });

  const { gh } = await resolvePlugin(subject.marketplaceId, subject.pluginName);
  const targetSha = await resolveTarget(gh, typeof body.targetSha === "string" ? body.targetSha : null);

  const outcome = await applyPluginReviewed({
    gh: { ...gh, ref: targetSha },
    marketplaceId: subject.marketplaceId, pluginName: subject.pluginName,
    scope: subject.scope, ownerId: subject.ownerId,
    installId: subject.installId, targetSha, actorId: userId, reviewHash: body.reviewHash,
    dispositions: (body.dispositions ?? {}) as Record<string, PolicyDisposition>,
    only: Array.isArray(body.only) ? body.only.filter((x): x is string => typeof x === "string") : undefined,
    performWrites: ({ operationId, plan, observations, installId }) => writeReviewedPlan({
      operationId, installId, plan, observations,
      target: { scope: subject.scope, userId: subject.ownerId, projectId: null },
      priorManifest: subject.manifest,
      fallbackVersion: targetSha.slice(0, 7),
    }),
  });

  switch (outcome.outcome) {
    case "succeeded":
      // The lifecycle journal already recorded this operation; this is the human-facing
      // "a plugin was installed/updated" line the Activity page has always shown.
      await audit({
        actorId: userId,
        action: subject.installId ? "plugin.update" : "plugin.install",
        targetType: "plugin", targetKey: subject.pluginName,
      });
      return Response.json({ ok: true });
    case "stale":
      // 409 with the FRESH review, so the screen can re-present it without another round
      // trip. It does not close the new window — the next accept rebuilds everything again.
      return Response.json({ error: "stale", review: outcome.review, policies: outcome.policies }, { status: 409 });
    case "blocked":
      return Response.json({ error: "blocked", review: outcome.review, policies: outcome.policies }, { status: 409 });
    case "rejected":
      return Response.json({ error: outcome.reason }, { status: 400 });
    case "failed":
      return Response.json({ error: "failed", errorCode: outcome.errorCode }, { status: 500 });
  }
});
