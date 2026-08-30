import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { auditEvents, memoryDocs } from "@/lib/db/schema";
import { proposeCandidate } from "./candidates";
import { fitStatement } from "./claims";
import { getOrCreateSpace, spaceAcceptsWrites } from "./spaces";
// Used here only to build a stable idempotency key, so that re-carrying a document
// appended to since its last pass is a no-op for the bullets already carried. It has to be
// the SAME normalization the dedup uses, which is why it is imported rather than repeated.
import { norm } from "./text";

/** "Never carried across, or appended to since it was." The selection below and the
 *  CAS in `migrateOne` MUST share this predicate: a widened selection over a
 *  narrower CAS would pick documents up and then refuse every one of them, which
 *  looks exactly like a migration that ran and found nothing.
 *
 *  A NULL `updated_at` (the column is nullable) makes the comparison NULL, i.e.
 *  false — a stamped document with no update time is not re-selected, which is the
 *  answer we want. */
export const notCarried = () => or(isNull(memoryDocs.migratedAt), lt(memoryDocs.migratedAt, memoryDocs.updatedAt));

/** How many consecutive failures one document gets before this process stops
 *  re-selecting it. The boot retry loop re-drives the migration every 60 seconds at
 *  its slowest, so a row that fails deterministically would otherwise be retried
 *  forever, and — until this commit stopped snapshotting content — grow the audit
 *  table on every pass. */
const MAX_ATTEMPTS = 5;

/** Consecutive failures per document id, for THIS PROCESS only.
 *
 *  BOUND: at most one entry per `memory_docs` row that is currently failing. An entry
 *  is deleted the moment its document migrates, and a document at `MAX_ATTEMPTS` is
 *  never selected again, so the map cannot outgrow the number of broken rows.
 *
 *  Deliberately NOT persisted. What this bounds is the in-process retry loop, and a
 *  restart almost always means new code — a deploy that fixes the cause should get a
 *  fresh attempt rather than inheriting a verdict from the binary that failed. */
const failures = new Map<string, number>();

/** What a failed document is allowed to say in a log line.
 *
 *  The installed Drizzle embeds EVERY bound parameter into the error message —
 *  statement text and JSON values included — so the raw error must never reach a log
 *  sink. A secret-shaped candidate that trips an FK or an encoding error would print
 *  the credential verbatim, undoing the screen that kept it out of the prompt: we
 *  would be refusing to show the secret to the model and then writing it to disk and
 *  to every attached log collector.
 *
 *  `code` and `constraint` come off the SAME object. Drizzle wraps the driver error
 *  as `cause` from 0.36 on while older versions reject with it directly (the pattern
 *  at `src/lib/marketplace/barrier.ts:50-56`), so reading one from the wrapper and
 *  the other from the cause would pair a code with somebody else's constraint.
 *  `name` is a class name, never data. `message` is deliberately absent. */
function pgFault(e: unknown): { code: string; constraint: string; errorName: string } {
  const wrapper = (e ?? {}) as { code?: unknown; constraint?: unknown };
  const cause = (e as { cause?: { code?: unknown; constraint?: unknown } })?.cause;
  const src = wrapper.code !== undefined ? wrapper : (cause ?? {});
  return {
    code: typeof src.code === "string" ? src.code : "unknown",
    constraint: typeof src.constraint === "string" ? src.constraint : "none",
    errorName: e instanceof Error ? e.name : typeof e,
  };
}

/**
 * Moves legacy memory documents into the review queue: line → bullet → PENDING
 * candidate with origin `legacy_memory_doc`.
 *
 * It used to write confirmed claims, on the reasoning that what was already in the
 * user's memory is not a proposal and asking them to re-confirm long-standing facts
 * would be a regression. That reasoning is now refused, and the refusal is the point of
 * this round: a legacy document is unreviewed free text that both the user and the agent
 * wrote into, and the whole guarantee being made is that nothing reaches the model
 * without a person keeping it. "It was already there" is exactly the argument that would
 * have let it through. The person keeps their own facts, once, from the review queue.
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
 * A ROLLING UPGRADE needs no fence, and this predicate is why. While both versions
 * are live the old one still accepts writes, so it can append after the new one has
 * stamped — but such an append moves `updated_at` past `migrated_at`, which is
 * exactly what the second half selects, and the next pass carries it. The earlier
 * note here claimed the opposite and asked for a "legacy writes are closed" flag;
 * that was written when the selector was `IS NULL` alone.
 *
 * What the widened selector does NOT fix by itself is the READERS. A reader testing
 * only `IS NULL` treats such a document as done and hides the late bullets from the
 * prompt and the memory page until something restarts. Hence `notCarried` is exported
 * and imported by both (`manifest.ts`, `api/memory-docs/route.ts`) rather than
 * restated: a reader that disagrees with the writer about what "carried" means is the
 * whole defect, and three copies of a condition is how they come to disagree.
 *
 * `docIds` narrows the selection and exists ONLY for tests: without it the call by
 * construction takes every unmigrated document in the database, which in a shared
 * test database would sweep up real ones too. Boot passes no argument, and its
 * behaviour is unchanged.
 */
export async function migrateMemoryDocs(opts: { docIds?: string[] } = {}): Promise<{ migrated: number }> {
  const selected = await db
    .select({ id: memoryDocs.id })
    .from(memoryDocs)
    .where(and(notCarried(), opts.docIds ? inArray(memoryDocs.id, opts.docIds) : undefined));
  // A document that has already exhausted its attempts is not selected at all, which
  // is what actually ends the retry: it stops reaching `failed` below, so the next
  // pass throws nothing and the loop in `migrate.ts` returns instead of spinning.
  const pending = selected.filter((d) => (failures.get(d.id) ?? 0) < MAX_ATTEMPTS);

  let migrated = 0;
  const failed: string[] = [];
  let firstError: unknown;
  for (const doc of pending) {
    try {
      if (await migrateOne(doc.id)) migrated++;
      // Only a real success clears the counter. `false` means another instance held
      // the CAS, which is neither a success nor a failure of ours.
      failures.delete(doc.id);
    } catch (e) {
      // Isolation PER DOCUMENT. Without it a single document that fails
      // deterministically (a NUL in legacy content written before `stripNul` closed
      // that path, say) would hide EVERY document after it from the migration — on
      // every boot, forever — and the `SELECT` above is unordered, so even "which
      // ones" would differ each time.
      const attempts = (failures.get(doc.id) ?? 0) + 1;
      failures.set(doc.id, attempts);
      failed.push(doc.id);
      firstError ??= e;
      log.error("vault: memory doc did not migrate", { docId: doc.id, attempts, ...pgFault(e) });
      if (attempts >= MAX_ATTEMPTS) {
        // The trace an operator needs: which row, and that nothing further will be
        // attempted for it until this process restarts.
        log.error("vault: giving up on a memory doc until restart", {
          docId: doc.id,
          attempts,
          // NOT "still serves the prompt" any more, and the correction matters to
          // whoever reads this line: the manifest's legacy fallback is gone, so an
          // uncarried document reaches the settings page and nothing else. The facts in
          // it are invisible to the assistant until this migration succeeds.
          hint: "this document stays unmigrated; its text serves the settings page only, and the assistant cannot see it",
        });
      }
    }
  }
  // Thrown ONCE, at the end: by then the remaining documents are migrated, and the
  // retry in `migrate.ts` has to stay armed — a quiet success with unmigrated
  // documents left behind would be worse than a noisy repeat.
  if (failed.length) {
    // `cause` is SCRUBBED, for the same reason the log line above is. A raw drizzle
    // error attached here walks straight past `pgFault`: the only caller does
    // `console.error("…", e)`, and Node's inspector prints the `[cause]` chain with
    // the wrapped message — every bound parameter included — once per retry pass. The
    // hygiene has to hold on everything that LEAVES this module, not only on the line
    // this module logs itself; a scrubber the exception chain can carry the payload
    // around is the same defect as a guard on one entrance of two.
    throw new Error(`${failed.length} memory doc(s) did not migrate: ${failed.join(", ")}`, { cause: pgFault(firstError) });
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
    // The project was deleted while this boot was migrating (teardown retires the space
    // and removes the project row in two separate transactions, so a boot can land
    // between them). There is nothing to carry into a space the user destroyed, and the
    // fences below would refuse anyway — but as a THROW, which this loop would read as
    // a document that failed and retry three times per boot, forever, logging an error
    // each time for a correct outcome. `migratedAt` was already stamped by the CAS
    // above, so returning here records the document as carried and stops it coming
    // back. `false`, not `true`: nothing was migrated.
    if (!(await spaceAcceptsWrites(spaceId, tx))) {
      log.info("vault: skipping a memory doc whose space was retired", { docId, spaceId });
      return false;
    }
    // Every bullet becomes a PENDING CANDIDATE, not a confirmed claim, and that is the
    // authority cutover reaching the oldest data in the system. This used to call
    // `createClaim(reviewStatus: "confirmed")` directly — a writer declaring its own
    // output approved, unattended, at boot, on text that predates every protection here.
    // The document is a file the user could edit by hand and the agent appended to after
    // every turn; nothing in it was ever reviewed, and a credential pasted into it years
    // ago went straight into the prompt.
    //
    // The cost is real and is the honest one: memory carried over from the old system
    // waits in the review queue until the person keeps it. Nothing is lost — the
    // document itself still serves the settings page and the export for as long as it
    // exists — and nothing is asserted on their behalf.
    //
    // Dedup lives in `proposeCandidate`, which answers `known` for a fact already in
    // memory and writes nothing at all. There is deliberately no second copy of that
    // rule here: the copy that used to live in this loop was the reason the migration
    // needed `confirmClaim` and `attachToTopic` of its own, and both of those were
    // writes this pass had no authority to make.
    let bullets = 0;
    for (const line of doc.content.split("\n")) {
      const statement = fitStatement(line.trim().replace(/^[-*]\s*/, "").trim());
      if (!statement) continue;
      bullets++;
      await proposeCandidate(
        {
          // Keyed by the TEXT, not by the line's position. A document appended to since
          // its last pass is re-selected (see the selector above), and a positional key
          // would make an edited line collide with whatever used to be at that index and
          // be silently dropped — while a text key re-proposes the edit and no-ops every
          // bullet already carried. The statement sits in this row's own `statement`
          // column anyway, so the key discloses nothing the row does not, and candidate
          // rows are deleted with their space rather than outliving it.
          idempotencyKey: `legacy:${docId}:${norm(statement)}`,
          spaceId,
          statement,
          provenance: { kind: "legacy_memory_doc" },
        },
        tx,
      );
    }

    // An audit event ATTESTS that something happened; it is not a second copy of the
    // data. The original markdown used to be stored here verbatim, which meant that
    // deleting a project left a complete copy of its memory in `audit_events` until the
    // whole account was deleted — the user's deletion was, for that text, a lie.
    // `retireProjectSpace` cannot help: it deletes claims and notes and deliberately
    // keeps the audit trail.
    //
    // So: the id, and how many bullets were carried. Nothing content-derived, and the
    // removal of the digest that used to sit here is the point of this paragraph. It was
    // an unsalted SHA-256 of the whole document, carried beside the exact character
    // count and the bullet count — and memory text is low entropy. A reader of the audit
    // log for a DELETED project could hash a small dictionary of likely one-line facts
    // against it and recover the statement the deletion existed to remove, with the
    // length and the count narrowing the guesses sharply. A salted hash would only be
    // useful for comparing two documents we no longer keep, which nothing does, and a
    // value nobody reads and everybody has to reason about is worse than none.
    //
    // ACCEPTED COST: headings, ordering and formatting existed only in the snapshot this
    // replaced, so a migrated document cannot be reconstructed from the audit trail.
    // Reversibility was worth less than not retaining the text past a user's own delete.
    await tx.insert(auditEvents).values({
      id: nanoid(),
      spaceId,
      actor: { kind: "system" },
      action: "system.memory_doc_migrated",
      subjectType: "memory_doc",
      subjectId: docId,
      payload: { docId, bullets },
    });
    return true;
  });
}
