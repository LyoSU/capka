import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, memoryCandidates } from "@/lib/db/schema";
import { log } from "@/lib/log";
import {
  attachEvidence,
  confirmClaim,
  createClaim,
  fitSlotKey,
  fitStatement,
  forgetClaim,
  headBySlot,
  listHeadClaims,
  secretShaped,
  updateClaim,
  type Actor,
  type ClaimHead,
  type EvidenceInput,
} from "./claims";
import { ownerAuthored } from "./grounding";
import { listMemoryToolRows } from "./model-view";
import { DEFAULT_TOPIC_KEY, getOrCreateTopicNote, spaceAcceptsWrites, type Ex } from "./spaces";
// One home for the statement normalization the slot branch and the slotless dedup share —
// and, since Task 9, the memory page's search box. See `text.ts` for why it is not copied.
import { norm } from "./text";

export type Provenance = {
  kind: "user_direct" | "derived" | "tool" | "file" | "web" | "legacy_memory_doc";
  messageId?: string;
  detail?: string;
};

export type CandidateRow = typeof memoryCandidates.$inferSelect;

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
 *
 * ONE RESIDUE, recorded here because the paragraphs above reason about exactly this class
 * for sensitive and unverified heads and did not name it. `known` and `pending` are
 * distinguishable replies, and this comparison reads `value`, which is NOT model-facing:
 * `MemoryToolRow.value` rides through the projection unbranded and no reader prints it. So
 * an agent that already knows a head's statement — which it may read — can probe that
 * head's stored `value` by proposing guesses, `known` on a deep-equal hit and `pending`
 * on a miss. Narrow today: the statement must already be model-visible, `value` is almost
 * always model-authored in the first place, absence short-circuits to agreement, and a
 * miss leaves a visible row in the person's queue. It stops being narrow the moment
 * something writes a `value` the model did not author, which is the same first reader of
 * `vault_claims.value` the supersede branch below is already waiting on.
 */
const valueAgrees = (headValue: unknown, candidateValue: unknown) =>
  candidateValue === undefined || candidateValue === null || isDeepStrictEqual(headValue ?? null, candidateValue);

/**
 * Which space an unqualified fact belongs to. Both writers into the ledger take it
 * from here, because they disagreed: extraction read an absent `scope` as the USER
 * space while the tools read it as the PROJECT one — the same field name, the
 * opposite meaning for its absence — so a merger codename stated inside one project
 * was filed as a fact about the person and injected into every other project and
 * chat.
 *
 * Least privilege decides which one wins: a project fact is visible inside that
 * project, a user fact follows the person everywhere, so inside a project the
 * narrower audience is the safe reading of silence. Anything that is not exactly
 * "user" — absent, or a value neither module recognises — takes it.
 *
 * `null` is "there is no space this may go to": an EXPLICIT project scope with no
 * project to file into. Not a fallback to the user space, which is a wider audience
 * than was asked for — and not a decision this function can make either, because
 * what to do about it depends on whether the caller has someone to ask. It answers
 * the question; the caller answers "and now what".
 *
 * The cost of "project wins", written down because it surprises people: a project
 * space is retired with its project (`retireProjectSpace`), so a fact about the
 * PERSON that they happened to state while sitting in a project chat dies when that
 * project is deleted. That is the right trade for confidentiality — the alternative
 * leaks a project's business into every other chat forever — but it is a real loss,
 * which is why both writers are told to set `scope:"user"` explicitly for facts about
 * the person rather than leaning on the default.
 */
export function spaceForScope(
  scope: "user" | "project" | undefined,
  spaces: { userSpaceId: string; projectSpaceId?: string | null },
): string | null {
  if (scope === "user") return spaces.userSpaceId;
  if (scope === "project") return spaces.projectSpaceId ?? null;
  return spaces.projectSpaceId ?? spaces.userSpaceId;
}

/**
 * What a confirmation is being asked to DO, read off the candidate row ONCE.
 *
 * A UNION, not a record carrying an optional `conflictsWith` beside a `policy_state`
 * string, and the difference is the whole of this fix. The optional field shipped: the
 * producer side was made to carry its evidence — `forceConflict` cannot compile without
 * the contested id — the memory page rendered "keeping this replaces «…»" from it, and
 * the consumer here never read the column at all. So the person authorised a replacement
 * and got a second head contradicting the first, in every later prompt, forever. That is
 * this feature's recurring defect in its purest form: a rule at one entrance while a
 * second walks past it. An optional field is ignorable in silence. A variant is not — its
 * payload does not exist on the other arm, so `tsc` refuses to reach for it without
 * narrowing, and narrowing is what makes the other branch visible to whoever writes the
 * third consumer.
 *
 * Discriminated on the EVIDENCE (`conflicts_with`), never on `policy_state`. Rows written
 * before the id became mandatory carry `policy_state = 'conflict'` pointing at nothing,
 * and a replacement with no named target is not a replacement — it is a plain fact the
 * page already renders as one. Reading the state string instead would send those rows
 * looking for a head that was never recorded.
 */
type ConfirmIntent =
  | { kind: "record" }
  | { kind: "replace"; contested: string };

/**
 * What a confirmation acts on: the head its text LANDS on (`head` — merged into, or
 * superseded; `null` means "none of them, write a new one"), and a live head it ENDS
 * outright (`retire`).
 *
 * Two fields rather than one, because a correction can meet a space that already holds
 * its own words. The replacement the person authorised has then, in substance, already
 * happened — the text is where it should be — and the contested claim is the only thing
 * left to remove. Superseding it instead writes a SECOND row carrying text the space
 * already has, which is exactly the outcome the `record` arm's dedup exists to prevent,
 * arriving through the arm that did not run it.
 */
type Target = { head: ClaimHead | null; retire: ClaimHead | null };

/**
 * The head this confirmation acts on, and the head it retires.
 *
 * The `switch` is the other half of the union's job: a variant added without a branch
 * here fails `tsc` on the missing return, so the next state cannot arrive the way
 * `replace` did — written on one side, walked past on the other.
 *
 * AND THAT IS NOT ENOUGH ON ITS OWN, which is this round's correction and the reason the
 * paragraph below exists. The union forces the new arm to EXIST and to be handled; it
 * says nothing about what the arm must DO once control is inside it. `replace` shipped
 * without the text dedup `record` runs — the one the comment two branches down calls
 * required — so a correction whose words were already a live head superseded the
 * contested one into a byte-identical twin. Adding a branch is itself an entrance event:
 * the obligations of the arm beside it have to be carried across by hand, because no
 * type can see them.
 *
 * WHAT THE TWO ARMS OWE, side by side, so the third one has a list to check against:
 *  - the text dedup — BOTH. `record` uses its answer as the target; `replace` uses it to
 *    discover that its target's replacement is already recorded.
 *  - which head the text lands on — `record` DISCOVERS it (the slot's head, or the head
 *    carrying the same words); `replace` is TOLD it by the producer. Differ by design:
 *    that is what the union is for.
 *  - retiring a second head — `replace` only, and only when the text landed elsewhere.
 *    Nothing is contested on the `record` side, so there is nothing to retire. By design.
 *  - not walking the chain forward, re-verifying the space through the read itself, and
 *    counting a sensitive head as usable — identical on both arms, and none of the three
 *    is a per-arm decision. A future arm inherits all three.
 *
 * `replace` reads the CONTESTED head by id, and does NOT walk the chain forward from it.
 * Not walking is the deliberate part: if somebody else superseded that claim in the
 * meantime, the chain's current head is a fact this person never saw and never authorised
 * replacing. So a contested head that is no longer live resolves to `null` and the
 * confirmation creates a separate head, superseding nothing — the asymmetric fallback
 * AMENDMENT 2 prescribes. A duplicate is one click for a person to repair; a wrong
 * supersession is silent data loss wearing a tidy face.
 *
 * `listHeadClaims` is what re-verifies the space at confirm time, not a second predicate:
 * it filters `space_id` and `superseded_at IS NULL` in the same statement, and the space
 * it is given is the candidate's own — which the CAS above already proved is one of the
 * caller's. A contested claim that has moved out of reach since propose simply is not in
 * the list.
 */
async function targetHead(
  intent: ConfirmIntent,
  spaceId: string,
  slotKey: string | null,
  statement: string,
  ex: Ex,
): Promise<Target> {
  // ONE read of the space's live heads, and the text dedup written ONCE over it. Both
  // arms owe that dedup, and a second copy of the rule beside the first is precisely how
  // the first came to be walked past.
  //
  // The dedup is required: propose performs it, and if confirm did not, a fact proposed
  // without a slot and then activated by another proposal would produce a SECOND
  // byte-identical head on confirmation — and the store would repeat the same thing back
  // to the human forever.
  const heads = await listHeadClaims(spaceId, {}, ex);
  const sameText = heads.find((h) => norm(h.statement) === norm(statement)) ?? null;

  switch (intent.kind) {
    // With a slot, "the existing head" means the head of the SLOT; without one, the head
    // carrying the same normalized text.
    case "record":
      return { head: slotKey ? await headBySlot(spaceId, slotKey, ex) : sameText, retire: null };
    case "replace": {
      const contested = heads.find((h) => h.id === intent.contested) ?? null;
      // The correction's own words are already a live head, and not the contested one:
      // confirm THAT head and end the contested claim, rather than growing the chain a
      // twin of a fact the space already asserts. This covers both orders one turn
      // produces — the plain candidate confirmed before the correction, and a contested
      // head an earlier correction already replaced (`contested` is then `null`, and the
      // dedup is what stops the fallback below from creating the duplicate instead).
      return sameText && sameText.id !== contested?.id
        ? { head: sameText, retire: contested }
        : { head: contested, retire: null };
    }
  }
}

/** Two CAS losses in a row. Thrown to roll back the WHOLE confirm transaction,
 *  including the `resolved_at` that step 1 set. The candidate stays open: "come
 *  back in a moment" is more honest than a quietly dropped fact. */
class TryAgain extends Error {}

/** ONE attempt lost its race and must be re-read. Thrown rather than returned, and the
 *  difference is not stylistic: an attempt can have written a supersede or a claim
 *  before it discovers that the head it was working from is no longer current, and a
 *  plain `return null` would COMMIT that half-move into the savepoint and then retry on
 *  top of it — two versions of one confirmation. Thrown, the savepoint rolls back and
 *  the retry starts from the world as it now is. Caught at the savepoint boundary, so
 *  the outer transaction (and its `resolved_at`) survives. */
class Retry extends Error {}

/**
 * The candidate ledger: the agent's ONLY way to reach memory, and since the authority
 * cutover it does not write a claim under any circumstances. Whatever the words say, a
 * model-initiated proposal lands `pending` and waits for a person.
 *
 * WHY THERE IS NO CONTENT TEST HERE ANY MORE, because the deleted code looked
 * reasonable and somebody will want it back. This used to activate a proposal whose
 * words overlapped the user's own turn (`verifyDirectProvenance`), and use the same
 * test in `memory_update` and `memory_forget`. The attack is decisive and no better
 * predicate exists: the user asks *"check whether Acme invoices are still paid
 * monthly"*, an injected vendor page tells the model to forget the claim it just
 * searched for, and every long word of that claim is in the user's own turn — so the
 * gate opens. Nothing in the TEXT separates the legitimate case from the attack,
 * because the model composes the call in both and the user's words are present either
 * way. Only a server-verifiable user ACTION can carry that authority, and that action
 * is the confirm on the memory page.
 *
 * So provenance is RECORDED and gates nothing. The cost is real and is stated in the
 * tool copy rather than hidden: memory is proposal-only, and the reply tells the person
 * their fact is waiting and where to confirm it. A silent pend is the black hole this
 * slice exists to close.
 *
 * The one thing it still reads is whether the fact is ALREADY recorded — see the
 * `known` branch, which writes nothing at all.
 *
 * The actor is always `agent`: a proposal is made by the agent's turn. Human decisions
 * arrive as separate calls (`confirmCandidate`/`rejectCandidate`) with their own actor,
 * and that difference is exactly what the audit log shows.
 *
 * Takes an `ex` so the boot migration can carry a legacy document's bullets in ONE
 * transaction with the stamp that says it carried them — the same reason
 * `rejectAllCandidates` takes one.
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
  /**
   * Record this proposal as contesting a NAMED head rather than as a plain pending
   * fact. `memory_update` is its one producer: a correction is not a fact somebody can
   * weigh on its own, so the page has to render "keeping this replaces «…»" and needs
   * both halves to do it.
   *
   * The claim id is required, and that requirement is the fix: this used to be a bare
   * `forceState?: "conflict"` flag, and the one caller that used it had the contested id
   * two lines earlier and did not pass it — so half the conflicts on the memory page
   * rendered "this disagrees with something" where the whole point was to show what.
   * A producer that cannot name the head it contests now fails to compile.
   *
   * It does NOT make `conflicts_with` non-null everywhere: rows written before this
   * requirement carry a bare conflict, and the projection renders that honestly.
   */
  forceConflict?: { conflictsWith: string };
}, ex?: Ex): Promise<
  /** The fact is already recorded and the model can already see it. NOTHING was
   *  written — no candidate row, no evidence, no change to any claim. That distinction
   *  is the point of the cutover: the state this replaces (`merged`) attached the turn
   *  as evidence and CONFIRMED the head it matched, so an injected proposal was a
   *  durable write and a quarantine escalation on somebody else's word. */
  | { state: "known"; claimId: string }
  // `denied` is unreachable here: no rule in this policy produces it, and
  // `rejectCandidate` does not rewrite `policy_state`. It stays in the contract for
  // the governance work in later plans.
  | { state: "pending" | "denied" | "conflict"; candidateId: string }
  | { state: "duplicate" }
  // The space was retired while this proposal was on its way — see the fence below.
  // No row, no candidate id: nothing was written.
  | { state: "retired" }
> {
  const actor: Actor = { kind: "agent" };
  const evidence = input.evidence ?? [];
  // An empty slot is an ABSENT slot, not a slot named "". The model behind the Task 7
  // tool returns `slot_key: ""` as an ordinary answer, and `""` is non-NULL. Normalize
  // ONCE, here, and use only `slotKey` from then on.
  const slotKey = fitSlotKey(input.slotKey);

  // Clamped and single-lined at the ledger too, not only on the claim writers: a
  // candidate row carries the statement verbatim into the review queue, and
  // `confirmCandidate` writes exactly this text. Trimming it at the moment of
  // confirmation instead would show the reviewer one string and store another.
  const statement = fitStatement(input.statement);

  // The SAME screen the writers hold, handed the RAW text so truncation cannot remove a
  // match — see `secretShaped`. It is ADVISORY here and everywhere: it decides whether
  // the person reviewing this row sees it flagged. It decides nothing about what the
  // model may read, because the person decides that now.
  const sensitive = input.sensitive || secretShaped(input.statement, input.slotKey, input.value);

  if (!ex || ex === db) return db.transaction((tx) => proposeCandidate(input, tx));

  // The lifecycle fence, and the FIRST statement in the transaction — it locks the
  // space row before any other, which is the order `retireProjectSpace` takes too. A
  // candidate row is memory just as much as a claim is: it carries the statement
  // verbatim and waits in the review queue, so "the claim was refused" would not be
  // enough on its own.
  //
  // Silence is the honest answer. Nobody did anything wrong — the user deleted a
  // project and a turn's extraction arrived a moment late — so this is neither a user
  // error nor an agent error. Logged at `info`, with the space id and NOT the
  // statement: the whole point is that this text does not get recorded in that space.
  if (!(await spaceAcceptsWrites(input.spaceId, ex))) {
    log.info("vault: proposal refused, space retired", { spaceId: input.spaceId });
    return { state: "retired" } as const;
  }

  // Is this fact already recorded? Read through the memory-tool channel — the widest one a
  // model can reach through a tool — so "already known" answers about exactly the facts the
  // model can see anyway and reveals nothing it could not have read for itself. It is
  // deliberately WIDER than the manifest: a fact the agent can find with `memory_search` is
  // one it already knows, and answering `pending` for it would put a decision in front of
  // the person for something already recorded.
  //
  // The hole this keeps shut is unchanged: `known` and `pending` are distinguishable
  // replies, so a projection that matched WITHHELD heads would let an agent confirm a
  // specific sensitive statement by proposing guesses at it. `owner_only` is in no channel,
  // so a proposal duplicating one lands `pending` and the person decides.
  //
  // The no-queries branch, which is a SET read and stamps no `last_used_at`: this asks
  // "does the space already hold these words", not "did the model just read this row", and
  // it runs on the hot path of post-turn extraction. `omitted` is destructured away because
  // that branch returns everything eligible and omits nothing.
  //
  // A forced conflict skips the read entirely: it is not asking whether the fact is
  // known, it is recording that it contests a named head.
  if (!input.forceConflict) {
    const { rows: knownRows } = await listMemoryToolRows([input.spaceId], undefined, ex);
    const known = knownRows.find(
      (h) => norm(h.excerpt) === norm(statement) && valueAgrees(h.value, input.value),
    );
    // No write of any kind, the candidate row included: a fact already in memory is not
    // a decision to put in front of anybody.
    if (known) return { state: "known", claimId: known.id } as const;
  }

  // Every model-initiated proposal lands here, whatever the words say. There is no
  // branch that activates — see the docstring for why no content test can be trusted
  // with that authority.
  const state = input.forceConflict ? "conflict" : "pending";
  const id = nanoid();
  const [row] = await ex
    .insert(memoryCandidates)
    .values({
      id,
      idempotencyKey: input.idempotencyKey,
      spaceId: input.spaceId,
      originMessageId: input.originMessageId ?? null,
      statement,
      slotKey: slotKey ?? null,
      value: input.value ?? null,
      provenance: input.provenance,
      // A pending candidate has no claim yet — the evidence waits here and is applied
      // by whoever confirms.
      evidence,
      sensitive,
      policyState: state,
      // Written WITH the row, not by a later UPDATE: a reader between two statements
      // would see a conflict with nothing to point at.
      conflictsWith: input.forceConflict?.conflictsWith ?? null,
    })
    .onConflictDoNothing({ target: memoryCandidates.idempotencyKey })
    .returning({ id: memoryCandidates.id });

  // This exact proposal was already handled. A COMPLETE no-op: no row, no event —
  // otherwise a replayed turn would duplicate the audit trail and the evidence.
  if (!row) return { state: "duplicate" } as const;

  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: input.spaceId,
    actor,
    action: "candidate.propose",
    subjectType: "candidate",
    subjectId: id,
    // No proposal text: the audit log is read more widely than the space itself, and
    // `retireProjectSpace` keeps these events after deleting the candidates — so
    // anything here outlives the user's deletion of the project. `slotKey` is proposal
    // text by design (a slot names its subject); `subject_id` is the addressing.
    payload: {
      state,
      // Recorded, and authorizing nothing — see `verifyDirectProvenance`.
      provenance: input.provenance.kind,
      ...(input.forceConflict ? { conflictsWith: input.forceConflict.conflictsWith } : {}),
    },
  });
  return { state, candidateId: id } as const;
}

/**
 * The human's "yes". One transaction, and the policy is re-evaluated FROM SCRATCH:
 * the world may have moved between proposal and confirmation, and what is being
 * confirmed is the candidate's content, not whatever state the slot was in once.
 *
 * FENCED against a retired space, as of its first caller (`POST
 * /api/memory/candidates/<id>`). Every branch that WRITES a claim already went through
 * `createClaim`/`updateClaim`, which are fenced; what was left open was the MERGE
 * branch — `attachEvidence`, `confirmClaim` and the `candidate.confirm` audit event —
 * and specifically the audit event, the one row of the three that would SURVIVE into a
 * retired space. The deadlock recorded on `assertSpaceLive` no longer applies either:
 * the fence reads the space BEFORE the CAS, so this move now takes the space row first
 * and the candidate row second, the same order `retireProjectSpace` takes them in.
 *
 * `statement` is the person's own wording, when they corrected the extraction before
 * saying yes. It replaces the candidate's text for EVERYTHING downstream — the dedup
 * read, the merge comparison, and the row that gets written — and it takes the
 * provenance with it: words the person typed are the person's, which is strictly
 * stronger evidence than whatever the extractor derived them from, so the origin
 * becomes `user_direct` rather than the candidate's inherited kind. That is the reason
 * editing is safe to offer at all; inheriting `derived` would file the human's own
 * sentence under the model's authority.
 */
export async function confirmCandidate(args: {
  candidateId: string;
  allowedSpaceIds: string[];
  actor: Actor;
  statement?: string;
}): Promise<{ ok: true; claimId: string } | { ok: false; reason: "already_resolved" | "not_found" | "try_again" }> {
  const { candidateId, allowedSpaceIds, actor } = args;
  try {
    return await db.transaction(async (tx) => {
      // The fence the docstring promised the first caller would need. Read UNLOCKED and
      // ahead of the CAS purely to fix the lock ORDER: `retireProjectSpace` takes the
      // space row and then the candidate rows, so fencing after the CAS would take them
      // the other way round and the two would deadlock. A candidate's `space_id` never
      // changes, so this read cannot go stale.
      const [scope] = await tx
        .select({ spaceId: memoryCandidates.spaceId })
        .from(memoryCandidates)
        .where(and(eq(memoryCandidates.id, candidateId), inArray(memoryCandidates.spaceId, allowedSpaceIds)))
        .limit(1);
      if (scope && !(await spaceAcceptsWrites(scope.spaceId, tx))) {
        return { ok: false, reason: "not_found" } as const;
      }

      // The CAS step comes next: it both arbitrates confirm/confirm and
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
      // Read once, at the top, from the row the CAS just returned — see `ConfirmIntent`.
      const intent: ConfirmIntent = cand.conflictsWith
        ? { kind: "replace", contested: cand.conflictsWith }
        : { kind: "record" };
      // `fitSlotKey`, the SAME function propose uses, not a second normalization that
      // happens to agree with it: these two only ever agreed because every candidate
      // row was written by propose first, and a future writer inserting a row directly
      // would split them (whitespace collapsing and the 120-char clamp live in
      // `fitSlotKey` alone). It also rescues rows written BEFORE that fix: a candidate
      // carrying `slot_key = ''` would otherwise never read the head, would hit 23505
      // on every insert and would return `try_again` FOREVER, with no way to confirm.
      const slotKey = fitSlotKey(cand.slotKey) ?? null;

      // The person's correction, or the extractor's sentence when they did not make one.
      // Clamped and single-lined HERE, by the same `fitStatement` the writers use, and
      // not at the writer alone: the dedup read below compares normalized text, so an
      // uncut edit could miss a head that the stored row then turns out to duplicate.
      // `undefined` and an edit are told apart on the parameter, never on equality with
      // the candidate's text — a person retyping the same sentence verbatim is still
      // asserting it in their own words.
      const edited = args.statement !== undefined;
      const statement = edited ? fitStatement(args.statement as string) : cand.statement;
      // Provenance follows the words. See the docstring: the human typed these, so the
      // origin is theirs, not the `derived`/`web`/`tool` kind the candidate inherited
      // from wherever the extractor read them.
      //
      // SPREAD, not replaced. Overwriting the whole object dropped `provenance.messageId`
      // — the pointer back to the turn this fact came out of — in a module whose entire
      // subject is provenance. What the edit changes is WHO the words belong to; where
      // they were first noticed is unaffected and still worth keeping.
      const origin: Record<string, unknown> = edited
        ? { ...(cand.provenance as Record<string, unknown>), kind: "user_direct", detail: "edited on the memory page" }
        : (cand.provenance as Record<string, unknown>);
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
          // No slot key, for the reason spelled out on `candidate.propose` above:
          // it is proposal text, not addressing, and these events outlive the space.
          payload: { claimId, policyState: cand.policyState },
        });
        return { ok: true, claimId } as const;
      };

      // Two attempts: losing the CAS is not an error but "the head just changed",
      // and the correct response to that is to re-read. A second loss in a row means
      // live contention for this slot, and then "come back later" is more honest.
      for (let attempt = 0; attempt < 2; attempt++) {
        const claimId = await tx
          .transaction(async (sp): Promise<string | null> => {
            // Which head this acts on — the contested one for a correction, the dedup's
            // for a plain fact. The choice is made in ONE function over the intent union
            // rather than inline here, so a state whose confirmation means something new
            // has to be answered there rather than silently falling through to the dedup.
            const { head, retire } = await targetHead(intent, cand.spaceId, slotKey, statement, sp);

            // The contested head, in the one case where this confirmation's words turned
            // out to be a live head already. `forgetClaim`, not `updateClaim`: there is
            // no new version to write — the successor exists as its own chain — and a
            // supersede here would mint exactly the twin the dedup just avoided. Same
            // savepoint as the confirmation below, so the two facts are never both live
            // and never both gone.
            if (retire) {
              const ended = await forgetClaim(
                { claimId: retire.id, expectedRevision: retire.revision, allowedSpaceIds, actor },
                sp,
              );
              if (!ended.ok) throw new Retry(); // lost the CAS — re-read
            }

            // Every head is usable here, sensitive ones included, and that is NOT the rule
            // propose holds — deliberately. `sensitive` withholds from the MODEL; the
            // actor at this entrance is the authenticated owner of the space, who is shown
            // both texts on their own memory page. A guard that read the two entrances as
            // one made a slotted candidate whose slot a sensitive head held answer
            // `try_again` on every attempt, forever: from a screen, a button that never
            // does anything. Sensitivity cannot fall through either branch below — the
            // merge confirms with `usable.sensitive || cand.sensitive` and the supersede
            // patches the same expression — so nothing is exposed by treating them alike.
            const usable = head;

            // The value is compared too, for the same reason as in propose — but the
            // outcome differs: the human has already said yes to THIS candidate, so a
            // divergent value is a correction to apply, not a conflict to hand back.
            // It therefore falls through to the supersede below. A candidate with NO
            // value stays here, in the merge, and the head keeps the number it had:
            // superseding on absence would clear it under a `{ok:true}`.
            if (usable && norm(usable.statement) === norm(statement) && valueAgrees(usable.value, cand.value)) {
              // This is the HUMAN's decision, so the head becomes confirmed — otherwise
              // `{ok:true}` would be returned for a fact the model will never see.
              //
              // The RESULT IS READ, and reading it is N1. `usable` came from a query a
              // few statements ago, so a supersede or a forget committing in that window
              // leaves this write landing on a row that has stopped being a head:
              // `confirmed` and the raised `sensitive` would go onto a dead version while
              // the live head carried neither, and `memory_candidates.claim_id` would
              // point at a claim that is no longer current — the page's own link from a
              // decision to its fact, aimed at the wrong version. A miss is not a failure
              // but live contention, and the answer to contention here is the same as a
              // lost CAS below: go round and re-read.
              //
              // Evidence is attached only AFTER the confirmation lands, for the same
              // reason: an attachment on a superseded row is a durable write for a
              // decision that did not take effect.
              if (!(await confirmClaim(usable.id, usable.sensitive || cand.sensitive, actor, sp))) throw new Retry();
              for (const ev of evidence) await attachEvidence(usable.id, ev, sp);
              return usable.id;
            }

            // Reached by a `replace` whose contested head is still live and says
            // something else — the case the memory page promised as "keeping this
            // replaces «…»" — and by a `record` with a slot whose head says something
            // else, and, since the value joined the comparison above, also without one
            // when the words match and the structured value does not. All of them are a
            // correction the human approved, so all of them supersede.
            //
            // THE SUPERSEDE IS `updateClaim`, not a second CAS invented here: its
            // predicate is already `id = $1 AND revision = $2 AND superseded_at IS NULL
            // AND space_id IN (…)`, and the successor it writes is the confirmed head —
            // so the replacement and the row it replaces are one statement apart inside
            // this savepoint, and there is no window in which both are live.
            if (usable) {
              const upd = await updateClaim(
                {
                  claimId: usable.id,
                  expectedRevision: usable.revision,
                  patch: {
                    statement,
                    // `undefined` makes `updateClaim` INHERIT the predecessor's value;
                    // passing the candidate's `null` straight through would write it,
                    // because a NULL jsonb arrives as `null` and the patch tests
                    // `!== undefined`. Same rule as the merge above: a candidate that
                    // asserts no value must not empty one.
                    //
                    // The cost of inheriting, accepted knowingly: a candidate can
                    // change the WORDS without asserting a value, and then the
                    // successor's value contradicts its own statement — "Acme pays in
                    // 60 days" carrying `{days:30}`. Nothing renders `value` today, and
                    // the alternative loses it on the far commoner rephrase, so the
                    // stale value is the cheaper wrong. The FIRST reader of
                    // `vault_claims.value` must revisit this: from then on the
                    // contradiction is visible, and the trade stops being free.
                    value: cand.value ?? undefined,
                    // Inheriting from the predecessor is exactly what must not happen
                    // here: the text came from THIS candidate — or, when the person
                    // rewrote it, from the person — so the provenance is whichever of
                    // those wrote the words (otherwise the successor would carry, say,
                    // `legacy_memory_doc` on something the user just said themselves),
                    // and sensitivity is a decision about IT, not about the predecessor.
                    // Sensitivity only rises: clearing it would expose something already
                    // closed.
                    //
                    // `reviewStatus` is NOT here any more, and its absence is the
                    // authority cutover: a writer may not declare its own output
                    // approved. The successor is born `unverified` and `confirmClaim`
                    // below is what approves it — one write grants authority, and it
                    // records who granted it.
                    //
                    // `updateClaim` carries approval across when a supersede rewrites no
                    // text, and this branch never is that case: it is reached only when
                    // the normalized statement or the value disagreed, and either of
                    // those is a rewrite. So the successor here is always born
                    // `unverified`, by argument rather than by luck.
                    origin,
                    sensitive: usable.sensitive || cand.sensitive,
                    // The predecessor may have been in no topic at all (created
                    // outside this ledger, for instance) — the confirmed head would
                    // then land outside the note projection, invisible to the GET.
                    topicNoteId: await getOrCreateTopicNote(cand.spaceId, DEFAULT_TOPIC_KEY, sp),
                  },
                  // The person clicked Keep on their own memory page — `confirmCandidate`'s
                  // only caller is that route — so the words are the owner's, whether they
                  // came from the candidate or from their own edit of it. Not
                  // `agent_inferred`: the class is what the SERVER can prove about the
                  // writer, and here it can prove an authenticated owner acted.
                  sourceClass: ownerAuthored(),
                  allowedSpaceIds,
                  actor,
                },
                sp,
              );
              if (!upd.ok) throw new Retry(); // lost the CAS — re-read
              // The successor is brand new and uncommitted, so this cannot miss — but it
              // is checked anyway, because "cannot miss" is an argument about today's
              // callers and `confirmClaim`'s result is the thing that must never be
              // discarded on the strength of one.
              if (!(await confirmClaim(upd.id, usable.sensitive || cand.sensitive, actor, sp))) throw new Retry();
              for (const ev of evidence) await attachEvidence(upd.id, ev, sp);
              return upd.id;
            }

            // No head to act on. For a `record` that is the ordinary case; for a
            // `replace` it means the contested claim is no longer live AND the correction's
            // own words are not already recorded either — somebody else superseded or
            // forgot it between the proposal and this click — and then the
            // fact is recorded BESIDE whatever replaced it and nothing is superseded. The
            // person authorised replacing a specific claim, not its successor, which they
            // have never seen. What they see afterwards is the new fact on their memory
            // page next to the other one, and two facts they can resolve in a click.
            const noteId = await getOrCreateTopicNote(cand.spaceId, DEFAULT_TOPIC_KEY, sp);
            const claim = await createClaim(
              {
                spaceId: cand.spaceId,
                statement,
                slotKey: slotKey ?? undefined,
                value: cand.value,
                origin,
                sensitive: cand.sensitive,
                topicNoteId: noteId,
                sourceClass: ownerAuthored(),
              },
              actor,
              sp,
            );
            // Born `unverified`, like every other new claim — see `ClaimInput`. This is
            // the write that approves it, and the only one that can.
            if (!(await confirmClaim(claim.id, cand.sensitive, actor, sp))) throw new Retry();
            for (const ev of evidence) await attachEvidence(claim.id, ev, sp);
            return claim.id;
          })
          // A lost race inside the attempt: the savepoint has already rolled back, so
          // the retry sees the world as it now is and starts from nothing. Any other
          // error is rethrown.
          .catch((e: unknown) => {
            if (e instanceof Retry) return null;
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

/**
 * The queue half of "forget everything": every unresolved candidate in one space.
 *
 * It lives beside `rejectCandidate` and `proposeCandidate` rather than inside
 * `forgetAllClaims` because `memory_candidates` is this module's table — the same rule
 * that keeps `vault_claims` inside `claims.ts`. A claims function resolving candidates
 * would be an inverse filed under the wrong writer, and the next person adding a column
 * here would have no reason to look for a second writer over there.
 *
 * It takes an `ex` where `rejectCandidate` does not, and that is the whole reason both
 * exist: a reset has to leave the claims and the queue in the same state, and
 * `rejectCandidate` opens its own transaction, so composing it in a loop would let a
 * failure land halfway — memory emptied, the queue still offering back the facts that
 * were in it.
 *
 * `policy_state` is left as it was, exactly as one rejection leaves it: the resolution is
 * recorded by the event, and the proposal's original state stays readable.
 */
export async function rejectAllCandidates(
  spaceId: string,
  actor: Actor,
  ex?: Ex,
): Promise<{ rejected: number }> {
  if (!ex || ex === db) return db.transaction((tx) => rejectAllCandidates(spaceId, actor, tx));

  const open = await ex
    .update(memoryCandidates)
    .set({ resolvedAt: new Date() })
    .where(and(eq(memoryCandidates.spaceId, spaceId), isNull(memoryCandidates.resolvedAt)))
    .returning({ id: memoryCandidates.id, policyState: memoryCandidates.policyState });
  if (!open.length) return { rejected: 0 };

  await ex.insert(auditEvents).values(
    open.map((cand) => ({
      id: nanoid(),
      spaceId,
      actor,
      action: "candidate.reject",
      subjectType: "candidate",
      subjectId: cand.id,
      // `rejectCandidate`'s payload plus `bulk`, for the reason recorded on
      // `forgetAllClaims`: a reset must not read back as a queue somebody worked through.
      payload: { policyState: cand.policyState, bulk: true },
    })),
  );
  return { rejected: open.length };
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
