import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, memoryCandidates } from "@/lib/db/schema";
import {
  attachEvidence,
  confirmClaim,
  createClaim,
  headBySlot,
  listHeadClaims,
  updateClaim,
  type Actor,
  type ClaimHead,
  type EvidenceInput,
} from "./claims";
import { DEFAULT_TOPIC, getOrCreateTopicNote, type Ex } from "./spaces";

export type Provenance = {
  kind: "user_direct" | "derived" | "tool" | "file" | "web" | "legacy_memory_doc";
  messageId?: string;
  detail?: string;
};

export type CandidateRow = typeof memoryCandidates.$inferSelect;

/** One normalization for comparing statements, shared by the slot branch and the
 *  slotless dedup. Different rules in those two places would mean the same fact
 *  merges or splits depending on whether a slot happens to be set. */
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * The other half of "the same fact": a matching statement whose structured `value`
 * DIFFERS is not a duplicate, it is a new reading of the same slot. Deciding a merge
 * on the statement alone answered "already known" and dropped the new value on the
 * floor — and a slot exists precisely for facts whose value changes over time.
 *
 * An ABSENT candidate value is "no opinion", NOT "the value is now empty". The
 * defect was a candidate carrying a DIFFERENT value overwriting nothing; a candidate
 * carrying no value asserts nothing to lose. Reading absence as a divergence is worse
 * than the bug it would be guarding: on the propose side it manufactures conflicts
 * out of a plain restatement, and on the confirm side it supersedes the head to
 * `value = null` — silently destroying the very number this comparison exists to
 * protect. Clearing a value on purpose is `memory_update`'s job, with an explicit
 * value; extraction never gets to do it by omission.
 *
 * `isDeepStrictEqual` rather than serialized text: jsonb does not preserve key order,
 * so `{days,tier}` and `{tier,days}` come back from the same row in either shape, and
 * comparing strings would split one fact in two by accident of the model's phrasing.
 *
 * A candidate value of literal `null` is indistinguishable from an absent one once it
 * is in the column, so it reads as "no opinion" too — the honest reading of a shape
 * the storage cannot tell apart.
 */
const valueAgrees = (headValue: unknown, candidateValue: unknown) =>
  candidateValue === undefined || candidateValue === null || isDeepStrictEqual(headValue ?? null, candidateValue);

/**
 * Whether this is "a competitor already took the slot" — and NOTHING else.
 *
 * Drizzle >=0.36 wraps the driver error, leaving the pg error in `cause`; older
 * versions throw it directly. Both shapes are read off ONE object: taking `code`
 * from `e` and `constraint` from `e.cause` would be checking two different errors.
 *
 * Both fields are checked. On `23505` alone, a violation of any other unique
 * index would land here and quietly take the "a competitor won" path where there
 * is no competitor — and the real fault would leave no trace.
 */
function isSlotTaken(e: unknown): boolean {
  const pg = ((e as { code?: unknown })?.code ? e : (e as { cause?: unknown })?.cause) as
    | { code?: unknown; constraint?: unknown }
    | undefined;
  return pg?.code === "23505" && pg?.constraint === "uniq_vclaims_active_slot";
}

/** Two CAS losses in a row. Thrown to roll back the WHOLE confirm transaction,
 *  including the `resolved_at` that step 1 set. The candidate stays open: "come
 *  back in a moment" is more honest than a quietly dropped fact. */
class TryAgain extends Error {}

/**
 * The candidate ledger is the ONLY way into memory: the agent does not write a
 * claim, it proposes one and policy decides. The whole policy runs in one outer
 * transaction; the steps that insert claims sit in a nested `tx.transaction()`,
 * which drizzle emits as a SAVEPOINT. Without it a unique violation would abort
 * the entire Postgres transaction, making "re-read and decide" impossible by
 * construction rather than by oversight.
 *
 * The actor here is always `agent`: a proposal is made by the agent's turn. Human
 * decisions arrive as separate calls (`confirmCandidate`/`rejectCandidate`) with
 * their own actor — and that difference is exactly what the audit log shows.
 */
export async function proposeCandidate(input: {
  idempotencyKey: string;
  spaceId: string;
  originMessageId?: string;
  statement: string;
  slotKey?: string;
  value?: unknown;
  provenance: Provenance;
  sensitive?: boolean;
  evidence?: EvidenceInput[];
  forceState?: "conflict";
  /** Honoured ONLY on the immediate-activation path. A candidate that went to
   *  pending does not remember a topic — `memory_candidates` has no such column —
   *  so `confirmCandidate` always files the fact under the default topic. In plan A
   *  that is unobservable (the GET in Task 10 reads only the default topic, and
   *  Task 7 passes nothing here); it becomes a real knob in plan D, along with the
   *  topic UI and a migration for the column. */
  topicNoteId?: string;
}): Promise<
  | { state: "auto_active"; claimId: string; revision: number }
  | { state: "merged"; claimId: string }
  // `denied` is unreachable here: no rule in this policy produces it, and
  // `rejectCandidate` does not rewrite `policy_state`. It stays in the contract for
  // the governance work in later plans.
  | { state: "pending" | "denied" | "conflict"; candidateId: string }
  | { state: "duplicate" }
> {
  const actor: Actor = { kind: "agent" };
  const evidence = input.evidence ?? [];
  // An empty slot is an ABSENT slot, not a slot named "". The model behind the
  // Task 7 tool returns `slot_key: ""` as an ordinary answer, and `""` is non-NULL,
  // i.e. a full participant in `uniq_vclaims_active_slot`. Without this the row
  // would store `""`, every branch below would take the slotless path (because
  // `""` is falsy) — and the claim insert would land OUTSIDE the savepoint, where
  // a 23505 aborts the whole transaction and escapes to the caller. Normalize
  // ONCE, here, and use only `slotKey` from then on.
  const slotKey = input.slotKey?.trim() || undefined;

  // The gate is evaluated BEFORE the insert: `policy_state` is NOT NULL, and a
  // provisional value plus a later UPDATE would only add a state nobody ever sees.
  const gate: "conflict" | "pending" | null =
    input.forceState === "conflict"
      ? "conflict"
      : input.sensitive
        ? "pending"
        : // What the user did not write themselves is never auto-activated. This is
          // the barrier against injection via a tool result, a file or a page.
          input.provenance.kind !== "user_direct"
          ? "pending"
          : null;

  return db.transaction(async (tx) => {
    const id = nanoid();
    const [row] = await tx
      .insert(memoryCandidates)
      .values({
        id,
        idempotencyKey: input.idempotencyKey,
        spaceId: input.spaceId,
        originMessageId: input.originMessageId ?? null,
        statement: input.statement,
        slotKey: slotKey ?? null,
        value: input.value ?? null,
        provenance: input.provenance,
        // A pending candidate has no claim yet — the evidence waits here and is
        // applied by whoever confirms.
        evidence,
        sensitive: input.sensitive ?? false,
        policyState: gate ?? "auto_active",
      })
      .onConflictDoNothing({ target: memoryCandidates.idempotencyKey })
      .returning({ id: memoryCandidates.id });

    // This exact proposal was already handled. A COMPLETE no-op: no row, no event
    // — otherwise a replayed turn would duplicate the audit trail and the evidence.
    if (!row) return { state: "duplicate" } as const;

    const audit = (state: string, payload: Record<string, unknown>) =>
      tx.insert(auditEvents).values({
        id: nanoid(),
        spaceId: input.spaceId,
        actor,
        action: "candidate.propose",
        subjectType: "candidate",
        subjectId: id,
        // No proposal text: the audit log is read more widely than the space itself.
        payload: { state, slotKey: slotKey ?? null, provenance: input.provenance.kind, ...payload },
      });

    if (gate) {
      await audit(gate, {});
      return { state: gate, candidateId: id } as const;
    }

    /** The fact is already known: top up the evidence and CLOSE the candidate. An
     *  open merged candidate would ask forever for confirmation of something that is
     *  already in memory.
     *
     *  ACCEPTED: evidence added to a head that is superseded concurrently stays on
     *  that — now inactive — version. This is historically honest (the evidence is
     *  about that exact wording), and aggregating the chain is plan D's job. */
    const merged = async (head: ClaimHead) => {
      const claimId = head.id;
      for (const ev of evidence) await attachEvidence(claimId, ev, tx);
      // A head the user's OWN statement merged into is a confirmed fact. Without
      // this, matching a head somebody created as `unverified` (a future migration
      // of the legacy memory doc, say) would leave it out of the Task 8 manifest:
      // the user just said it outright and memory stays silent about it. The gate
      // above guarantees no sensitive proposal reaches here, so the head's own
      // sensitivity is simply preserved.
      await confirmClaim(claimId, head.sensitive, tx);
      await tx
        .update(memoryCandidates)
        .set({ claimId, policyState: "auto_active", resolvedAt: new Date() })
        .where(eq(memoryCandidates.id, id));
      await audit("merged", { claimId });
      return { state: "merged", claimId } as const;
    };

    /** The slot holds a different statement — leave the head alone, the choice is
     *  the human's. */
    const conflict = async (conflictsWith: string | null) => {
      await tx
        .update(memoryCandidates)
        .set({ policyState: "conflict", conflictsWith })
        .where(eq(memoryCandidates.id, id));
      await audit("conflict", { conflictsWith });
      return { state: "conflict", candidateId: id } as const;
    };

    const activate = async (sp: Ex) => {
      const noteId = input.topicNoteId ?? (await getOrCreateTopicNote(input.spaceId, DEFAULT_TOPIC, sp));
      const claim = await createClaim(
        {
          spaceId: input.spaceId,
          statement: input.statement,
          slotKey,
          value: input.value,
          origin: { ...input.provenance },
          // NOT "unverified": the Task 8 manifest lists only confirmed claims, so a
          // fact the user just saved would otherwise be invisible.
          reviewStatus: "confirmed",
          // `sensitive` is omitted deliberately, not by oversight: the gate above
          // routes every sensitive proposal to pending, so only non-sensitive ones
          // reach here. If that gate ever changes, this site must change with it.
          topicNoteId: noteId,
        },
        actor,
        sp,
      );
      for (const ev of evidence) await attachEvidence(claim.id, ev, sp);
      return claim;
    };

    const activated = async (claim: { id: string; revision: number }) => {
      await tx
        .update(memoryCandidates)
        .set({ claimId: claim.id, policyState: "auto_active", resolvedAt: new Date() })
        .where(eq(memoryCandidates.id, id));
      await audit("auto_active", { claimId: claim.id });
      return { state: "auto_active", claimId: claim.id, revision: claim.revision } as const;
    };

    /** "Already known" means the words, and a value that does not contradict the
     *  head's. A candidate asserting a DIFFERENT value is a decision for a human, not
     *  something to absorb into an existing row; a candidate asserting none merges
     *  exactly as it always did. */
    const same = (head: ClaimHead) =>
      norm(head.statement) === norm(input.statement) && valueAgrees(head.value, input.value);

    if (slotKey) {
      const head = await headBySlot(input.spaceId, slotKey, tx);
      if (head) return same(head) ? merged(head) : conflict(head.id);

      let claim: { id: string; revision: number };
      try {
        claim = await tx.transaction(activate);
      } catch (e) {
        if (!isSlotTaken(e)) throw e;
        // A competitor committed a head into this slot while we were inserting ours.
        // The 23505 arrives only AFTER their commit (until then the INSERT simply
        // waits on the index lock), so a read-committed re-read already sees them.
        const winner = await headBySlot(input.spaceId, slotKey, tx);
        // No head — between their commit and our read a third party forgot or
        // superseded it. We neither invent a winner nor surface a pg error: the slot
        // is contested, so the candidate stays open for a human.
        if (!winner) return conflict(null);
        return same(winner) ? merged(winner) : conflict(winner.id);
      }
      return activated(claim);
    }

    // With no slot there is no unique index (`uniq_vclaims_active_slot` is partial
    // on `slot_key IS NOT NULL`), so a 23505 is impossible and a SAVEPOINT here
    // would be an empty wrapper.
    //
    // ACCEPTED (GPT audit #6): this dedup READS the heads and then writes, with no
    // index to arbitrate the gap, so two concurrent proposals of the same slotless
    // statement produce two heads. Closing it means a unique index on the NORMALIZED
    // statement — a schema change with its own cost (it would also forbid two
    // deliberately identical facts under different topics), and the outcome here is a
    // duplicate a human curates away, not a lost or mis-scoped fact. Same for a race
    // between two DIFFERENT statements, which is not a defect at all.
    const heads = await listHeadClaims(input.spaceId, {}, tx);
    // The value is compared here too: the rule cannot depend on whether a slot
    // happens to be set, or the same pair of facts merges or conflicts by accident.
    const dup = heads.find((h) => norm(h.statement) === norm(input.statement));
    if (dup) return same(dup) ? merged(dup) : conflict(dup.id);
    return activated(await activate(tx));
  });
}

/**
 * The human's "yes". One transaction, and the policy is re-evaluated FROM SCRATCH:
 * the world may have moved between proposal and confirmation, and what is being
 * confirmed is the candidate's content, not whatever state the slot was in once.
 */
export async function confirmCandidate(args: {
  candidateId: string;
  allowedSpaceIds: string[];
  actor: Actor;
}): Promise<{ ok: true; claimId: string } | { ok: false; reason: "already_resolved" | "not_found" | "try_again" }> {
  const { candidateId, allowedSpaceIds, actor } = args;
  try {
    return await db.transaction(async (tx) => {
      // The CAS step comes FIRST: it both arbitrates confirm/confirm and
      // confirm/reject and takes the row lock — leaving no window between checking
      // "still open" and writing.
      const [cand] = await tx
        .update(memoryCandidates)
        .set({ resolvedAt: new Date() })
        .where(
          and(
            eq(memoryCandidates.id, candidateId),
            isNull(memoryCandidates.resolvedAt),
            inArray(memoryCandidates.spaceId, allowedSpaceIds),
          ),
        )
        .returning();

      if (!cand) {
        // "Already resolved" and "does not exist" are told apart under the same
        // space filter: someone else's candidate reads as non-existent, never as
        // "exists, but not yours".
        const [seen] = await tx
          .select({ id: memoryCandidates.id })
          .from(memoryCandidates)
          .where(and(eq(memoryCandidates.id, candidateId), inArray(memoryCandidates.spaceId, allowedSpaceIds)))
          .limit(1);
        return { ok: false, reason: seen ? "already_resolved" : "not_found" } as const;
      }

      const evidence = (cand.evidence ?? []) as EvidenceInput[];
      // The same normalization as in propose, for the same reason — and here it
      // also rescues rows written BEFORE that fix: a candidate carrying
      // `slot_key = ''` would otherwise never read the head, would hit 23505 on
      // every insert and would return `try_again` FOREVER, with no way to confirm it.
      const slotKey = cand.slotKey?.trim() || null;
      const origin = cand.provenance as Record<string, unknown>;
      const finish = async (claimId: string) => {
        // `policy_state` is left as it was: the pending→confirmed transition is
        // recorded by the event, not by rewriting the proposal's state.
        await tx.update(memoryCandidates).set({ claimId }).where(eq(memoryCandidates.id, cand.id));
        await tx.insert(auditEvents).values({
          id: nanoid(),
          spaceId: cand.spaceId,
          actor,
          action: "candidate.confirm",
          subjectType: "candidate",
          subjectId: cand.id,
          payload: { claimId, policyState: cand.policyState, slotKey },
        });
        return { ok: true, claimId } as const;
      };

      // Two attempts: losing the CAS is not an error but "the head just changed",
      // and the correct response to that is to re-read. A second loss in a row means
      // live contention for this slot, and then "come back later" is more honest.
      for (let attempt = 0; attempt < 2; attempt++) {
        const claimId = await tx
          .transaction(async (sp): Promise<string | null> => {
            // With a slot, "the existing head" means the head of the SLOT; without
            // one, the head carrying the same normalized text. The dedup is required
            // here: propose (step 7) performs it, and if confirm did not, a sensitive
            // fact proposed without a slot and then activated by another proposal
            // would produce a SECOND byte-identical head on confirmation — and the
            // store would repeat the same thing back to the human forever.
            const head = slotKey
              ? await headBySlot(cand.spaceId, slotKey, sp)
              : ((await listHeadClaims(cand.spaceId, {}, sp)).find(
                  (h) => norm(h.statement) === norm(cand.statement),
                ) ?? null);

            // The value is compared too, for the same reason as in propose — but the
            // outcome differs: the human has already said yes to THIS candidate, so a
            // divergent value is a correction to apply, not a conflict to hand back.
            // It therefore falls through to the supersede below. A candidate with NO
            // value stays here, in the merge, and the head keeps the number it had:
            // superseding on absence would clear it under a `{ok:true}`.
            if (head && norm(head.statement) === norm(cand.statement) && valueAgrees(head.value, cand.value)) {
              for (const ev of evidence) await attachEvidence(head.id, ev, sp);
              // This is the HUMAN's decision, so the head becomes confirmed —
              // otherwise `{ok:true}` would be returned for a fact the manifest will
              // never show.
              await confirmClaim(head.id, head.sensitive || cand.sensitive, sp);
              return head.id;
            }

            // Reached with a slot whose head says something else, and — since the
            // value joined the comparison above — also without one, when the words
            // match and the structured value does not. Both are a correction the human
            // approved, so both supersede.
            if (head) {
              const upd = await updateClaim(
                {
                  claimId: head.id,
                  expectedRevision: head.revision,
                  patch: {
                    statement: cand.statement,
                    // `undefined` makes `updateClaim` INHERIT the predecessor's value;
                    // passing the candidate's `null` straight through would write it,
                    // because a NULL jsonb arrives as `null` and the patch tests
                    // `!== undefined`. Same rule as the merge above: a candidate that
                    // asserts no value must not empty one.
                    value: cand.value ?? undefined,
                    // Inheriting from the predecessor is exactly what must not happen
                    // here: the text came from THIS candidate, so the provenance is
                    // its own (otherwise the successor would carry, say,
                    // `legacy_memory_doc` on something the user just said themselves),
                    // and review/sensitive are decisions about IT, not about the
                    // predecessor. Sensitivity only rises: clearing it would expose
                    // something already closed.
                    origin,
                    reviewStatus: "confirmed",
                    sensitive: head.sensitive || cand.sensitive,
                    // The predecessor may have been in no topic at all (created
                    // outside this ledger, for instance) — the confirmed head would
                    // then land outside the note projection, invisible to the GET.
                    topicNoteId: await getOrCreateTopicNote(cand.spaceId, DEFAULT_TOPIC, sp),
                  },
                  allowedSpaceIds,
                  actor,
                },
                sp,
              );
              if (!upd.ok) return null; // lost the CAS — re-read
              for (const ev of evidence) await attachEvidence(upd.id, ev, sp);
              return upd.id;
            }

            const noteId = await getOrCreateTopicNote(cand.spaceId, DEFAULT_TOPIC, sp);
            const claim = await createClaim(
              {
                spaceId: cand.spaceId,
                statement: cand.statement,
                slotKey: slotKey ?? undefined,
                value: cand.value,
                origin,
                reviewStatus: "confirmed",
                sensitive: cand.sensitive,
                topicNoteId: noteId,
              },
              actor,
              sp,
            );
            for (const ev of evidence) await attachEvidence(claim.id, ev, sp);
            return claim.id;
          })
          // The slot was taken between our read and our insert — the same response
          // as a lost CAS: re-read. Any other constraint is rethrown.
          .catch((e: unknown) => {
            if (isSlotTaken(e)) return null;
            throw e;
          });

        if (claimId) return finish(claimId);
      }

      throw new TryAgain();
    });
  } catch (e) {
    if (e instanceof TryAgain) return { ok: false, reason: "try_again" };
    throw e;
  }
}

/** The human's "no": the same CAS resolve that arbitrates the race with confirm.
 *  `policy_state` is not rewritten — the rejection is recorded by the event, and
 *  the proposal's original state stays readable. */
export async function rejectCandidate(args: {
  candidateId: string;
  allowedSpaceIds: string[];
  actor: Actor;
}): Promise<{ ok: boolean }> {
  const { candidateId, allowedSpaceIds, actor } = args;
  return db.transaction(async (tx) => {
    const [cand] = await tx
      .update(memoryCandidates)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(memoryCandidates.id, candidateId),
          isNull(memoryCandidates.resolvedAt),
          inArray(memoryCandidates.spaceId, allowedSpaceIds),
        ),
      )
      .returning({
        id: memoryCandidates.id,
        spaceId: memoryCandidates.spaceId,
        policyState: memoryCandidates.policyState,
      });
    if (!cand) return { ok: false };

    await tx.insert(auditEvents).values({
      id: nanoid(),
      spaceId: cand.spaceId,
      actor,
      action: "candidate.reject",
      subjectType: "candidate",
      subjectId: cand.id,
      payload: { policyState: cand.policyState },
    });
    return { ok: true };
  });
}

/** A space's review queue, oldest first: a human works through it from the start,
 *  not from the end. Served by `idx_mcand_unresolved`. */
export async function listOpenCandidates(spaceId: string): Promise<CandidateRow[]> {
  return db
    .select()
    .from(memoryCandidates)
    .where(and(eq(memoryCandidates.spaceId, spaceId), isNull(memoryCandidates.resolvedAt)))
    .orderBy(asc(memoryCandidates.createdAt), asc(memoryCandidates.id));
}

/**
 * Whether the user really wrote this: at least 60% of the statement's words longer
 * than three characters appear in the text of their own turn. A blunt filter
 * against injection — so a tool result or a web page cannot claim the user said it.
 *
 * Its weaknesses (negation, quotation, reporting someone else's words) are known
 * and accepted: the cost of being wrong is one extra confirmation prompt, not a
 * lost fact, so making this filter cleverer is not worth it. Short words are
 * excluded because they appear in any text and confirm nothing; if there are no
 * long words at all there is nothing to establish authorship with, and `false`
 * (that is, pending) is the only honest answer.
 */
export function verifyDirectProvenance(statement: string, userTurnText: string): boolean {
  const words = statement
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3);
  if (words.length === 0) return false;
  const haystack = userTurnText.toLowerCase();
  return words.filter((w) => haystack.includes(w)).length / words.length >= 0.6;
}
