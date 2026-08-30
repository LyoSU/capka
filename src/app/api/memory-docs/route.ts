import { and, eq, inArray } from "drizzle-orm";
import { requireActive, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { memoryDocs, projects, spaces, vaultNotes } from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";
import { listHeadClaims } from "@/lib/vault/claims";
import { notCarried } from "@/lib/vault/migrate-memory-docs";
import { DEFAULT_TOPIC_KEY } from "@/lib/vault/spaces";

/**
 * The read side of the old memory editor, kept alive across the cutover on the
 * SAME response shape (`{ user, projects: [{ id, name, content }] }`) so the pages
 * that render it did not have to move in this commit too.
 *
 * `content` is no longer a document — it is a projection of the vault: the confirmed,
 * non-sensitive heads filed under the default topic, one markdown bullet each. It
 * reads, and never writes: nothing here calls `getOrCreateSpace`, so opening the
 * settings page cannot conjure a space for a user who has no memory yet.
 *
 * The FALLBACK is what keeps memory from disappearing for even a minute. A document
 * `notCarried()` still considers uncarried has not made it across, so its own text is
 * returned verbatim — the same predicate the migration writes by and the prompt
 * manifest falls back on, imported from the module that defines it rather than
 * restated here.
 *
 * It is ADDITIVE, like the manifest, and not a precedence: the two are concatenated
 * when both exist. Legacy-first precedence would have hidden a fact the model can
 * plainly see — a claim recorded this session while the document is still
 * unmigrated. Normally that divergence lasts seconds, but a document that fails
 * `migrateOne` deterministically rolls `migrated_at` back on every retry and never
 * progresses, so the page would hide those facts permanently with nothing on screen
 * to explain it. Showing both can repeat a fact for the length of the migration
 * window; that is the cheaper error, and the same trade the manifest already makes.
 */

/** Claims a scope shows: confirmed, NON-SENSITIVE heads under the default topic, as
 *  bullets. A space with no such topic yet projects to "" rather than erroring — an
 *  empty section is the honest answer for a space nobody has written to.
 *
 *  WHERE THE SENSITIVITY RULE LIVES: nowhere, and that is the actual defect behind
 *  this filter. `listHeadClaims` deliberately returns sensitive heads — the memory
 *  tools have to be able to look one up to correct or forget it, so the data layer
 *  cannot default to hiding them — which leaves every projection to remember on its
 *  own. There are now three enforcement points and no owner: `recentFacts` and
 *  `topicCounts` in `manifest.ts` (agent-facing), and this one (human-facing). This
 *  route was the one that forgot, and printed "confirmed sensitive" statements
 *  verbatim on the settings page while the prompt correctly withheld them. A single
 *  admission policy every reader must pass through is plan D's to build; until it
 *  exists, a new projection has to be added to this list by hand.
 *
 *  FILTERED, not redacted, and the choice is narrow. A marker ("1 sensitive fact
 *  hidden") would be friendlier — the user cannot currently tell that anything is
 *  being withheld, so they cannot ask the assistant to forget a fact they cannot see
 *  — but `content` is a plain unlocalized string rendered straight into a textarea,
 *  with nowhere to put a translated sentence, and this codebase does not ship English
 *  prose into a Ukrainian-first UI. Showing the user what is held back belongs to the
 *  real memory page (plan D), which has both the surface and the controls for it.
 *  Recorded here rather than in a plan document, on the code that is incomplete. */
async function project(spaceId: string | undefined): Promise<string> {
  if (!spaceId) return "";
  const [topic] = await db
    .select({ id: vaultNotes.id })
    .from(vaultNotes)
    .where(
      // By KEY, not by title. This route dies with `/api/memory-docs` (plan D1, Task 12);
      // it is corrected here because until then it is a live reader of the title-as-key
      // defect, and leaving one caller on the old rule is how that defect survived nine
      // reviews.
      and(
        eq(vaultNotes.spaceId, spaceId),
        eq(vaultNotes.topicKey, DEFAULT_TOPIC_KEY),
        eq(vaultNotes.kind, "memory_topic"),
      ),
    )
    .limit(1);
  if (!topic) return "";
  const heads = await listHeadClaims(spaceId, { topicNoteId: topic.id, onlyConfirmed: true });
  return heads
    .filter((h) => !h.sensitive)
    .map((h) => `- ${h.statement}`)
    .join("\n");
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

  // Legacy documents still awaiting migration, by scope. `notCarried()` is the
  // migration's own predicate rather than a local `isNull(migratedAt)`: a reader that
  // restates the condition stops agreeing with the writer the moment the writer
  // changes, and it already had — "stamped, but appended to since" is uncarried, and
  // a stale reader hides exactly those late bullets from this page.
  const legacyRows = await db
    .select({ projectId: memoryDocs.projectId, content: memoryDocs.content })
    .from(memoryDocs)
    .where(and(eq(memoryDocs.userId, userId), notCarried()));
  const legacy = (projectId: string | null) =>
    legacyRows.find((r) => (projectId === null ? r.projectId === null : r.projectId === projectId))?.content ?? "";

  // Claims first, then the not-yet-carried document underneath — the same order the
  // manifest puts them in, so the page and the prompt list a scope's memory the same
  // way round.
  const both = (claims: string, legacyText: string) => [claims, legacyText].filter(Boolean).join("\n\n");

  return Response.json({
    user: both(await project(userSpaceId), legacy(null)),
    projects: await Promise.all(
      projectRows.map(async (p) => ({
        id: p.id,
        name: p.name,
        content: both(await project(projectSpaceId(p.id)), legacy(p.id)),
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
  // The SAME gate this route had before the cutover, deliberately: `requireActive`
  // would have widened it to `viewer`. The 409 is constant and touches nothing, so
  // the difference is invisible in effect — which is exactly why it would have
  // survived unnoticed as a standing authorization change nobody decided to make.
  await requireRole("admin", "user");
  return Response.json({ error: "memory_moved" }, { status: 409 });
});
