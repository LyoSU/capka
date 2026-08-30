import { and, eq, inArray, isNull } from "drizzle-orm";
import { requireActive, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { memoryDocs, projects, spaces, vaultNotes } from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";
import { listHeadClaims } from "@/lib/vault/claims";
import { DEFAULT_TOPIC } from "@/lib/vault/spaces";

/**
 * The read side of the old memory editor, kept alive across the cutover on the
 * SAME response shape (`{ user, projects: [{ id, name, content }] }`) so the pages
 * that render it did not have to move in this commit too.
 *
 * `content` is no longer a document — it is a projection of the vault: the confirmed
 * heads filed under the default topic, one markdown bullet each. It reads, and never
 * writes: nothing here calls `getOrCreateSpace`, so opening the settings page cannot
 * conjure a space for a user who has no memory yet.
 *
 * The FALLBACK is what keeps memory from disappearing for even a minute. A document
 * whose `migrated_at` is still NULL has not been carried across yet, so its own text
 * is returned verbatim — exactly the condition the prompt manifest falls back on, so
 * the screen and the model never disagree about which half of the move a scope is in.
 */

/** Claims a scope shows: confirmed heads under the default topic, as bullets. A
 *  space with no such topic yet projects to "" rather than erroring — an empty
 *  section is the honest answer for a space nobody has written to. */
async function project(spaceId: string | undefined): Promise<string> {
  if (!spaceId) return "";
  const [topic] = await db
    .select({ id: vaultNotes.id })
    .from(vaultNotes)
    .where(
      and(eq(vaultNotes.spaceId, spaceId), eq(vaultNotes.title, DEFAULT_TOPIC), eq(vaultNotes.kind, "memory_topic")),
    )
    .limit(1);
  if (!topic) return "";
  const heads = await listHeadClaims(spaceId, { topicNoteId: topic.id, onlyConfirmed: true });
  return heads.map((h) => `- ${h.statement}`).join("\n");
}

export const GET = apiHandler(async () => {
  const { userId } = await requireActive();

  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.userId, userId), projectNotDeleted))
    .orderBy(projects.name);

  // One lookup for every space this user can see, keyed by what it refers to. The
  // user space's refId IS the user id; a project space's is the project id.
  const refIds = [userId, ...projectRows.map((p) => p.id)];
  const spaceRows = await db
    .select({ id: spaces.id, type: spaces.type, refId: spaces.refId })
    .from(spaces)
    .where(and(inArray(spaces.refId, refIds), eq(spaces.ownerUserId, userId)));
  const userSpaceId = spaceRows.find((s) => s.type === "user" && s.refId === userId)?.id;
  const projectSpaceId = (id: string) => spaceRows.find((s) => s.type === "project" && s.refId === id)?.id;

  // Legacy documents still awaiting migration, by scope. Only the unmigrated ones
  // are selected — a migrated document's text lives on solely in the audit snapshot,
  // and showing it next to the claims derived from it would double every fact.
  const legacyRows = await db
    .select({ projectId: memoryDocs.projectId, content: memoryDocs.content })
    .from(memoryDocs)
    .where(and(eq(memoryDocs.userId, userId), isNull(memoryDocs.migratedAt)));
  const legacy = (projectId: string | null) =>
    legacyRows.find((r) => (projectId === null ? r.projectId === null : r.projectId === projectId))?.content ?? "";

  const userLegacy = legacy(null);
  return Response.json({
    user: userLegacy || (await project(userSpaceId)),
    projects: await Promise.all(
      projectRows.map(async (p) => ({
        id: p.id,
        name: p.name,
        content: legacy(p.id) || (await project(projectSpaceId(p.id))),
      })),
    ),
  });
});

/**
 * The fence. Memory is no longer a document anyone can overwrite: a hand-edit here
 * would have to become a claim with provenance, and inventing one from a textarea is
 * the opposite of what the vault is for. The new editor (topics, confirmations,
 * conflicts) is plan D; until then this refuses rather than pretending to save.
 *
 * It is also half of what makes the migration's selector safe to widen: with this
 * closed and the turn-time writers deleted, nothing moves `memory_docs.updated_at`
 * any more, so a carried document is never re-selected.
 */
export const PUT = apiHandler(async () => {
  await requireActive();
  return Response.json({ error: "memory_moved" }, { status: 409 });
});
