import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, memoryDocs } from "@/lib/db/schema";
import { attachToTopic, confirmClaim, createClaim, listHeadClaims } from "./claims";
import { DEFAULT_TOPIC, getOrCreateSpace, getOrCreateTopicNote } from "./spaces";

/** The same normalization as in `candidates.ts`. Different rules here would mean
 *  the same fact merges or splits depending on which path carried it into
 *  memory. */
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/** "Never carried across, or appended to since it was." The selection below and the
 *  CAS in `migrateOne` MUST share this predicate: a widened selection over a
 *  narrower CAS would pick documents up and then refuse every one of them, which
 *  looks exactly like a migration that ran and found nothing.
 *
 *  A NULL `updated_at` (the column is nullable) makes the comparison NULL, i.e.
 *  false — a stamped document with no update time is not re-selected, which is the
 *  answer we want. */
const notCarried = () => or(isNull(memoryDocs.migratedAt), lt(memoryDocs.migratedAt, memoryDocs.updatedAt));

/**
 * Moves legacy memory documents into claims: line → bullet → confirmed claim with
 * origin `legacy_memory_doc`. The actor is `system`, not the candidate ledger:
 * what was already in the user's memory is not a proposal awaiting review, and
 * asking them to re-confirm their own long-standing facts would be a regression.
 *
 * THE SELECTOR is "not stamped, OR appended to since the stamp"
 * (`migrated_at IS NULL OR migrated_at < updated_at`), and the second half is what
 * closes a window that would otherwise lose facts silently. Before the cutover,
 * `memory_docs` had FOUR writers going through `optimisticUpdate` in the
 * since-deleted `src/lib/memory/` — `maintainMemoryDoc` (the runner, after EVERY
 * turn), `rememberFact`, `forgetFact` and `setMemoryDoc` — while boot stamped
 * `migrated_at` underneath them. Anything appended AFTER a stamp was carried
 * nowhere: an `IS NULL` selector skips it, and the manifest's legacy fallback reads
 * that same column, so the bullet disappears from the screen with no error at all.
 * The cutover deletes those writers and this pass sweeps up what they left.
 *
 * The cost of the second half is bounded and was weighed: a bullet the user EDITED
 * after the stamp migrates as a new claim beside the old one (an insert, not a
 * supersede), because dedup is by normalized text. A duplicate fact the user can
 * see and forget is strictly better than a fact that vanishes.
 *
 * It also converges rather than re-running forever. The stamp is set to `now()` and
 * nothing touches `updated_at` any more — the writers are gone and the PUT 409s —
 * so a document migrated once is past its `updated_at` and never re-selected.
 *
 * THE SINGLE-WRITER ASSUMPTION is "one box, and the PUT already 409s". The `ee/`
 * Helm chart with a rolling replica breaks it — two versions of the app are live at
 * once and the old one still accepts writes — and that needs a fence (a "legacy
 * writes are closed" flag set BEFORE the move), not this selector. Written down
 * explicitly so plan B/EE does not walk into it silently.
 *
 * `docIds` narrows the selection and exists ONLY for tests: without it the call by
 * construction takes every unmigrated document in the database, which in a shared
 * test database would sweep up real ones too. Boot passes no argument, and its
 * behaviour is unchanged.
 */
export async function migrateMemoryDocs(opts: { docIds?: string[] } = {}): Promise<{ migrated: number }> {
  const pending = await db
    .select({ id: memoryDocs.id })
    .from(memoryDocs)
    .where(and(notCarried(), opts.docIds ? inArray(memoryDocs.id, opts.docIds) : undefined));

  let migrated = 0;
  const failed: string[] = [];
  let firstError: unknown;
  for (const doc of pending) {
    try {
      if (await migrateOne(doc.id)) migrated++;
    } catch (e) {
      // Isolation PER DOCUMENT. Without it a single document that fails
      // deterministically (a NUL in legacy content written before `stripNul` closed
      // that path, say) would hide EVERY document after it from the migration — on
      // every boot, forever — and the `SELECT` above is unordered, so even "which
      // ones" would differ each time.
      failed.push(doc.id);
      firstError ??= e;
      console.error(`[vault] memory doc ${doc.id} did not migrate:`, e);
    }
  }
  // Thrown ONCE, at the end: by then the remaining documents are migrated, and the
  // retry in `migrate.ts` has to stay armed — a quiet success with unmigrated
  // documents left behind would be worse than a noisy repeat.
  if (failed.length) {
    throw new Error(`${failed.length} memory doc(s) did not migrate: ${failed.join(", ")}`, { cause: firstError });
  }
  return { migrated };
}

/** One document, one transaction. A failure mid-document rolls back both the
 *  claims and `migrated_at`, so the next boot picks it up whole; half a document
 *  never lands in memory. */
async function migrateOne(docId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The CAS step comes FIRST: it takes the row lock and re-checks `notCarried` in
    // one statement, leaving no window between the check and the write. Zero rows
    // means another instance (or an earlier run) claimed the document — a skip, not
    // an error. The timestamp is the DATABASE clock (`now()`), like `created_at` on
    // every neighbouring table: a stamp from the container's clock could not honestly
    // be compared against them — and `updated_at`, which this is now compared
    // against, is exactly such a neighbour.
    const [doc] = await tx
      .update(memoryDocs)
      .set({ migratedAt: sql`now()` })
      .where(and(eq(memoryDocs.id, docId), notCarried()))
      .returning();
    if (!doc) return false;

    const spaceId = await getOrCreateSpace(
      doc.projectId
        ? // The project space's owner comes from the DOCUMENT itself: a project's
          // chats share one space, and reading the project row here would buy nothing.
          { type: "project", refId: doc.projectId, ownerUserId: doc.userId }
        : { type: "user", refId: doc.userId },
      tx,
    );
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC, tx);

    // Dedup against the space's existing heads — this covers both a repeat after a
    // partial failure and a match with a fact the user already stated themselves.
    // The head's `sensitive` is carried along, not just its id: confirming below
    // rewrites that column, and passing anything else would declassify a fact
    // somebody had closed.
    const seen = new Map(
      (await listHeadClaims(spaceId, {}, tx)).map((h) => [norm(h.statement), { id: h.id, sensitive: h.sensitive }]),
    );
    for (const line of doc.content.split("\n")) {
      const statement = line.trim().replace(/^[-*]\s*/, "").trim();
      if (!statement) continue;
      const known = seen.get(norm(statement));
      if (known !== undefined) {
        // The fact exists — but possibly outside every topic (something other than
        // the candidate ledger may have created it). Simply skipping the bullet would
        // leave the row in the database and remove it from the screen: the GET reads
        // the default topic.
        await attachToTopic(known.id, noteId, tx);
        // And possibly UNVERIFIED, which the Task 8 manifest does not list either —
        // so attaching alone would stamp the document migrated while the fact stayed
        // invisible, this time one layer down. A legacy document is memory the user
        // has been looking at and silently accepting; it is no less confirmed than
        // whatever already sits in the vault under the same words.
        await confirmClaim(known.id, known.sensitive, tx);
        continue;
      }
      const claim = await createClaim(
        {
          spaceId,
          statement,
          origin: { kind: "legacy_memory_doc" },
          // NOT "unverified": a manifest of confirmed facts would otherwise show
          // nothing of what the user saw in their memory yesterday.
          reviewStatus: "confirmed",
          topicNoteId: noteId,
        },
        { kind: "system" },
        tx,
      );
      // Created confirmed and non-sensitive, so a repeated bullet inside the SAME
      // document takes the branch above and changes nothing.
      seen.set(norm(statement), { id: claim.id, sensitive: false });
    }

    // The only copy of the original markdown that survives the move: the bullets are
    // derived from it, while headings, order and formatting exist only here.
    await tx.insert(auditEvents).values({
      id: nanoid(),
      spaceId,
      actor: { kind: "system" },
      action: "system.memory_doc_migrated",
      subjectType: "memory_doc",
      subjectId: docId,
      payload: { content: doc.content, docId },
    });
    return true;
  });
}
