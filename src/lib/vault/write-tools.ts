import { and, eq, isNull } from "drizzle-orm";
import type { TurnTaint } from "@/lib/tasks/turn-taint";
import { db } from "@/lib/db";
import { vaultEdges, vaultNodes, vaultNotes } from "@/lib/db/schema";
import { EDIT_SNIPPET_MAX_BYTES, type VaultBudget } from "./budget";
import {
  attachEvidence,
  attachToTopic,
  createClaim,
  findCurrentHead,
  forgetClaim,
  findExactDuplicate,
  secretShaped,
  updateClaim,
  type Actor,
  type PromptAccess,
  type SourceClass,
} from "./claims";
import { linkNodes, unlinkEdge, unlinkReferencesFrom } from "./edges";
import { classify, type Grounding } from "./grounding";
import type { HandleMap } from "./handles";
import { numberLine } from "./line-view";
import { appendLinkBlock, serializeBlocks, type NoteBlock } from "./links";
import { openNoteForModel } from "./model-view";
import { applyInsert, applyStrReplace, type EditResult } from "./note-edit";
import {
  NOTE_BLOCKS_MAX,
  NOTE_BLOCK_MAX_CHARS,
  createNote,
  forgetNote,
  noteHead,
  reviseNote,
  type NoteSection,
} from "./notes";
import { spaceAcceptsWrites, type Ex } from "./spaces";
import { isTitleFoldConflict } from "./title-fold";
import { resolveTopic } from "./topics";

/**
 * THE WRITE HALF OF THE MEMORY TOOLS — `memory_fact_write`, `memory_note_write` and
 * `memory_link`, with `memory_file` and `memory_forget` beside them.
 *
 * It is a module of its own rather than three hundred more lines in `tools.ts` because the
 * two halves answer different questions: `tools.ts` decides what the model may SEE, and
 * this decides what the model may STORE. The one thing they share is the per-turn context,
 * which is why `WriteCtx` is a parameter here and a closure there.
 *
 * It is MODEL-FACING, and `model-view.test.ts` now walks it as such: the unfiltered
 * accessors (`listHeadClaims`, `headBySlot`) may not appear in it, and its returns carry
 * no claim text this module composed out of a row it read.
 */

/**
 * The TOOL-facing grounding union, carrying HANDLES.
 *
 * `grounding.ts`'s `Grounding` carries CLASSES, and the two are deliberately two names
 * over two shapes. `factWrite` resolves every handle through `ctx.handles` and rejects the
 * WHOLE mutation if any of them fails (§4.1) before it calls `classify` at all — so
 * `Grounding`'s `classes` array is never a partial resolution, and a value of one shape
 * cannot be passed where the other is expected. One name over two shapes is the LOW-6
 * mistake Task 1 exists to close, and it does not get to come back one module over.
 */
export type GroundingInput =
  | { kind: "current_user_quote"; quote: string }
  | { kind: "retrieved"; handles: string[] }
  | { kind: "agent_inference" };

/**
 * One turn's write context. Every field has the TURN's lifetime, not the call's: the
 * handle map, the budget and the taint are the three per-turn objects `prepareRun` builds
 * exactly once (see `makeVaultMemoryTools`), and `taskId`/`messageId`/`userTurnText`
 * identify the half of the turn this write runs in.
 */
export type WriteCtx = {
  userSpaceId: string;
  /** `null` in a chat that is not inside a project — which is a legal state, not a
   *  missing value, and the reason `refused_no_project` exists. */
  projectSpaceId: string | null;
  handles: HandleMap;
  taint: TurnTaint;
  budget: VaultBudget;
  taskId: string;
  messageId: string;
  userTurnText: string;
  actor: Actor;
};

export type FactWriteStatus =
  | "created"
  | "known"
  | "superseded"
  | "recorded_conflict"
  | "refused_scope"
  | "refused_no_project"
  | "downgraded"
  | "topic_secret_fallback"
  | "revision_mismatch"
  | "retired"
  | "bad_handle"
  | "bad_value_json";

/**
 * THE MODEL'S ONLY FEEDBACK, so it teaches — and so it withholds.
 *
 * There is no `pending` and there is no approval: this tool writes, and what it wrote is
 * on the person's memory page in the same release with one-click undo. That is the whole
 * of the maintainer's no-gate decision, and `it("has no pending status …")` is what keeps
 * a later "just add a confirm step" from landing quietly.
 *
 * What it does NOT carry is which of rule 1's four clauses failed (NEW-4). `status:
 * "downgraded"` plus the resulting class is the whole diagnosis the model gets; the clause
 * goes to the `claim.create` audit payload and the owner's row detail. Naming it here is a
 * rephrase-until-it-passes gradient, and step 4's exact-hash dedup does not stop one: a
 * one-word rephrase has a different `normalized_hash`, can land `user_direct`, and leaves
 * both rows stored.
 */
export const SAID: Record<FactWriteStatus, string> = {
  created: "Saved.",
  known: "Already saved - nothing to do.",
  superseded: "Replaced the earlier fact. The previous wording is kept as history.",
  recorded_conflict: "Recorded next to the existing fact as a disagreement - it does not replace it. The user will see both.",
  refused_scope:
    "A fact learned from a document or a web page cannot be saved as personal memory. Save it to the project, or state it as your own conclusion.",
  // ONE sentence for two routes into one circumstance, which is why it says both halves:
  // the model asked for `scope: "project"` where there is none, or the fact came out
  // untrusted and only a project could have held it. §4.5's wording is the second half.
  refused_no_project:
    "This chat is not inside a project, so there is no project memory to save to, and nowhere to store knowledge taken from documents or web pages. Nothing was saved.",
  downgraded: "Saved, but not as something the user stated - recorded as your conclusion.",
  topic_secret_fallback: "The topic name looked like a credential, so it was filed under General instead.",
  revision_mismatch: "That fact has moved on. Run memory_search and re-issue against what is there.",
  retired: "This project's memory was deleted. Nothing was saved.",
  bad_handle: "That address is not from this conversation's search results. Run memory_search and use a handle it returned.",
  bad_value_json: "value_json is not valid JSON. Re-send with corrected JSON or omit it.",
};

/** The untrusted-turn arm of `recorded_conflict`, which is a different sentence from the
 *  weaker-class one: the person needs to know WHY their fact was not replaced, and "this
 *  turn read a document" is the half they can act on. `SAID.recorded_conflict` is the
 *  weaker-class wording, so the roster above stays one sentence per status. */
const CONFLICT_UNTRUSTED_TURN =
  "Recorded as a disagreement rather than a replacement, because this turn read a document or a web page. The user decides which stands.";

export type FactWriteResult =
  | {
      status: "created" | "downgraded" | "topic_secret_fallback";
      handle: string;
      revision: number;
      sourceClass: SourceClass;
      promptAccess: PromptAccess;
      said: string;
    }
  | { status: "superseded"; handle: string; revision: number; sourceClass: SourceClass; said: string }
  | { status: "known"; handle: string; said: string }
  | {
      status: "recorded_conflict";
      handle: string;
      /** The TARGET's handle, never its persistent id: an id in a tool result is an id an
       *  injected page can quote back. */
      conflictsWith: string;
      reason: "weaker_class" | "untrusted_turn";
      sourceClass: SourceClass;
      said: string;
    }
  | { status: "revision_mismatch"; revision: number; said: string }
  | { status: "refused_scope" | "refused_no_project" | "retired" | "bad_handle" | "bad_value_json"; said: string };

/**
 * THE SUPERSEDE RANK — over `SourceClass` ITSELF, with no channel vocabulary in it.
 *
 * §4.5 step 5 compares the replacement's authority against the target's, "computed over the
 * server-verified class" and never over the stored `prompt_access`: `sensitive` collapses
 * every class to `owner_only`, which is a display bound and not a trust tier, so ranking on
 * that column would refuse a person's own correction of their own sensitive fact.
 *
 * WRITTEN AS A TOTAL MAP RATHER THAN A TERNARY, and that is the whole of review MED-1. The
 * ternary this replaces named the three channels and fell through to the STRONGEST of them,
 * while the generated column it mirrored falls through to the WEAKEST — so a sixth
 * `source_class` (that enum is touched most slices) would have arrived with maximum
 * supersede authority, silently, on the one comparison the spec calls a bound. `satisfies
 * Record<SourceClass, …>` makes a sixth class a COMPILE ERROR instead: there is no default
 * arm to be wrong, because there is no default arm.
 *
 * And it is no longer a second rendering of `prompt_access` (MED-2). The three trusted
 * classes share a rank because they share an authority, which is the same reason they share
 * a channel — a common cause, not a copy — so a module that needs the CHANNEL still has
 * exactly one place to read it: the generated column.
 */
const CLASS_RANK = {
  legacy_confirmed: 3,
  owner_authored: 3,
  user_direct: 3,
  agent_inferred: 2,
  untrusted_derived: 1,
} satisfies Record<SourceClass, 1 | 2 | 3>;

/**
 * The class half of §4.5 step 5: may a replacement at class `replacement` supersede a target
 * at class `target`? EQUAL OR STRONGER, so equality passes — which is what makes the turn's
 * taint the load-bearing second condition rather than a belt on this one.
 *
 * EXPORTED so the pin can call the real thing. The previous test compared the database
 * against a third hand-written copy of the map while this function stayed module-private, so
 * the drift it claimed to catch was exactly the drift it could not see (MED-2).
 */
export const mayOutrank = (replacement: SourceClass, target: SourceClass): boolean =>
  CLASS_RANK[replacement] >= CLASS_RANK[target];

/** An arbitrary value travels as a JSON STRING: `asSchema` collapses an open
 *  `z.record`/`z.unknown` into `additionalProperties: false` and the provider receives a
 *  schema the model cannot satisfy. Broken JSON is a RESULT, not a throw — a throw ends the
 *  step, a result leaves the model a next step to re-send in. */
function parseValueJson(raw: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * ONE handle to the class of what it addresses, or `null` for "resolves to nothing".
 *
 * `null` is the §4.1 answer and the caller rejects the whole mutation on it — a handle
 * from a previous run, a fabricated one, one from a space this turn cannot see, and one
 * whose row is no longer a live head all arrive here as the same nothing, deliberately:
 * telling them apart would tell the model which invented handles happen to exist.
 *
 * A FRAGMENT or a SOURCE is `untrusted_derived` by construction and needs no read — that
 * is what document content IS (§4.4), and slice 3 cannot make it anything else. An EDGE
 * resolves to nothing here although it resolves fine elsewhere: an edge carries no
 * statement, so it cannot be what a fact was learned from.
 */
async function classOfHandle(
  handle: string,
  ctx: WriteCtx,
  allowedSpaceIds: string[],
  ex: Ex,
): Promise<SourceClass | null> {
  const t = ctx.handles.resolve(handle);
  if (!t || !allowedSpaceIds.includes(t.spaceId)) return null;
  if (t.kind === "e" || t.kind === "f") return "untrusted_derived";
  if (t.kind === "m") return (await findCurrentHead(t.nodeId, [t.spaceId], ex))?.sourceClass ?? null;
  if (t.kind === "n") return (await noteHead(t.nodeId, [t.spaceId], ex))?.sourceClass ?? null;
  return null;
}

const badHandle = (bad: string[]): FactWriteResult => ({
  status: "bad_handle",
  said: `${SAID.bad_handle} Unusable: ${bad.join(", ")}.`,
});

/** THE ADDRESS IS RESOLVED BEFORE ANYTHING IS DECIDED, and an unresolvable one rejects the
 *  WHOLE mutation (§4.1). Shared by both writers because both compute a class from the same
 *  fold and neither may proceed with a hole: a fact or a note saved with part of its
 *  grounding silently gone is a row at a class nobody asked for.
 *
 *  It returns EVERY bad handle rather than the first, so one call tells the model which of
 *  its addresses to re-search rather than one per round trip. */
async function resolveGrounding(
  g: GroundingInput,
  ctx: WriteCtx,
  allowedSpaceIds: string[],
  ex: Ex,
): Promise<{ ok: true; grounding: Grounding } | { ok: false; bad: string[] }> {
  if (g.kind !== "retrieved") return { ok: true, grounding: g };
  const classes: SourceClass[] = [];
  const bad: string[] = [];
  for (const h of g.handles) {
    const cls = await classOfHandle(h, ctx, allowedSpaceIds, ex);
    if (cls) classes.push(cls);
    else bad.push(h);
  }
  return bad.length ? { ok: false, bad } : { ok: true, grounding: { kind: "retrieved", classes } };
}

/**
 * `memory_fact_write`, as §4.5 defines it.
 *
 * THE NINE STEPS RUN IN THEIR LITERAL ORDER, with the step numbers in comments, because
 * §4.5's own round-2 fix WAS a renumbering: round 1 put scope legality at step 1 and the
 * class computation at step 2, so the scope check ran before the class existed and always
 * passed. An implementer who reorders these for tidiness reproduces round 0.
 */
export async function factWrite(a: {
  op:
    | { kind: "create"; scope: "user" | "project" }
    | { kind: "replace"; targetHandle: string; expectedRevision: number };
  statement: string;
  grounding: GroundingInput;
  topic?: string;
  sensitive?: boolean;
  valueJson?: string;
  ctx: WriteCtx;
}): Promise<FactWriteResult> {
  const { ctx } = a;
  const allowedSpaceIds = ctx.projectSpaceId ? [ctx.userSpaceId, ctx.projectSpaceId] : [ctx.userSpaceId];

  const parsed = parseValueJson(a.valueJson);
  if (!parsed.ok) return { status: "bad_value_json", said: SAID.bad_value_json };
  const value = parsed.value;

  // WHERE THIS WRITE LANDS, decided before a transaction is opened, because a transaction
  // needs a space to be opened against. Both arms are in-memory: `scope` is the model's
  // word and the handle map is this run's own closure.
  //
  // The `refused_no_project` arm is step 3's, hoisted above the transaction for that
  // reason — and hoisting cannot change its answer, because it does not depend on the
  // class: an explicit `scope: "project"` with no project is refused whatever the fact is,
  // never absorbed into the user space. That silent re-scoping is the defect
  // `memory_propose` was corrected for; project memory follows one project and user memory
  // follows the person everywhere, so it is not a fallback but a different audience.
  /** The `replace` arm's two fields, captured once so every later use is one narrowing
   *  rather than a repeated `a.op.kind === "replace" ? … : …` whose false arm is
   *  unreachable and would still have to say something. */
  const replacing = a.op.kind === "replace" ? a.op : null;
  let spaceId: string;
  let target: { id: string; revision: number; sourceClass: SourceClass } | null = null;
  if (a.op.kind === "create") {
    if (a.op.scope === "project" && !ctx.projectSpaceId) {
      return { status: "refused_no_project", said: SAID.refused_no_project };
    }
    spaceId = a.op.scope === "project" ? (ctx.projectSpaceId as string) : ctx.userSpaceId;
  } else {
    const t = ctx.handles.resolve(a.op.targetHandle);
    // `m` only: a note is addressed by `memory_note_write`, and answering a note handle
    // with a claim write would file a fact somewhere the model did not point.
    if (!t || t.kind !== "m" || !allowedSpaceIds.includes(t.spaceId)) return badHandle([a.op.targetHandle]);
    // The TARGET's space, which is what makes step 3 cover `replace` without a scope: a
    // correction cannot choose where it lands, it lands where the fact it corrects lives.
    spaceId = t.spaceId;
  }

  return db.transaction(async (tx): Promise<FactWriteResult> => {
    // STEP 9, and it is the FIRST statement of the write for the reason every vault writer
    // states: `retireProjectSpace` takes the space row first, so a shared lock order is
    // what keeps the two from deadlocking. The claim writers and `resolveTopic` each fence
    // again — this one is the whole move's, and it is what makes `retired` a status rather
    // than a throw out of a nested call.
    if (!(await spaceAcceptsWrites(spaceId, tx))) return { status: "retired", said: SAID.retired };

    // §4.1 — THE ADDRESS IS RESOLVED BEFORE ANYTHING IS DECIDED, and an unresolvable one
    // rejects the WHOLE mutation. A fact is never saved with its grounding silently
    // dropped: the grounding is what the class is computed from, so a write that lost one
    // handle would be a write at a class nobody asked for.
    if (replacing) {
      const head = await findCurrentHead(ctx.handles.resolve(replacing.targetHandle)!.nodeId, [spaceId], tx);
      // Forgotten or superseded since the handle was minted. Not `revision_mismatch`:
      // that status carries "it is now at revision N", and there is no N.
      if (!head) return badHandle([replacing.targetHandle]);
      // Checked here although `updateClaim` re-checks it under the row lock, because the
      // CONFLICT arm never reaches `updateClaim` at all — and a disagreement recorded
      // against a revision the model never saw would put a stale "replaces «…»" in front
      // of the person.
      if (head.revision !== replacing.expectedRevision) {
        return { status: "revision_mismatch", revision: head.revision, said: SAID.revision_mismatch };
      }
      target = { id: head.id, revision: head.revision, sourceClass: head.sourceClass };
    }

    const resolved = await resolveGrounding(a.grounding, ctx, allowedSpaceIds, tx);
    if (!resolved.ok) return badHandle(resolved.bad);
    const grounding: Grounding = resolved.grounding;

    // STEP 1 — resolve the grounding to a CLASS. Rule 1's four clauses for a quote, the
    // least-trusted of the resolved handles for `retrieved`, the taint-capped floor for an
    // inference. The statement goes in RAW: clause 4 measures its own words.
    const verdict = classify(grounding, {
      statement: a.statement,
      userTurnText: ctx.userTurnText,
      untrustedIngressSeen: ctx.taint.seen(),
    });

    // STEP 2 — secret-shaped text is sensitive whatever the caller asked for, and
    // `prompt_access` follows by generation. Both claim writers screen again on the text
    // they are about to store; this is the step, not a second boundary.
    const sensitive = a.sensitive === true || secretShaped(a.statement, undefined, value);

    // STEP 3 IS THE FENCE H9 ASKED FOR, and it must stay above steps 4-8: NOTHING BELOW THIS
    // LINE CAN REACH A USER SPACE WITH AN UNTRUSTED CLASS. The conflict rule (step 5) is
    // reached only after scope legality has already answered.
    //
    // ONE line covers `create` and `replace` alike, which is what the spec asks for: the
    // replace arm's space is the target's, so a correction learned from a document cannot
    // rewrite a personal fact by addressing it instead of by scoping to it.
    //
    // A NON-UNTRUSTED PERSONAL FACT STATED INSIDE A PROJECT CHAT DOES WRITE TO PERSONAL
    // MEMORY (Q1, maintainer's decision). `scope: "user"` from within a project chat is
    // legal for the two trusted classes, which is what makes "you told Capka you prefer X"
    // work in every later chat instead of being trapped in the project where it was said.
    // The residual is misfiling, not leakage, and the row is visible with its scope shown.
    if (verdict.sourceClass === "untrusted_derived" && spaceId === ctx.userSpaceId) {
      // WHICH refusal, and it is a choice of TEACHING SENTENCE rather than a second rule:
      // both refuse, both write nothing, and step 4 is unreachable either way.
      //
      // `refused_scope` says "save it to the project, or state it as your own conclusion",
      // and in a chat with no project space BOTH halves are dead ends — there is no project,
      // and a tainted turn floors an inference at `untrusted_derived` too, so restating it
      // as a conclusion lands right back here. §4.5 gives that circumstance its own sentence
      // for exactly this reason, and round 1 emitted it only when the model had literally
      // typed `scope: "project"` (review MED-3). The circumstance is the absent project, not
      // the word the model used to reach it.
      return ctx.projectSpaceId
        ? { status: "refused_scope", said: SAID.refused_scope }
        : { status: "refused_no_project", said: SAID.refused_no_project };
    }

    // STEP 4 — an exact `normalized_hash` duplicate in this space. Nothing is written, the
    // existing handle comes back, and that is the whole of §8's exact-match dedup: a
    // rephrase is a different hash and lands as a second row for the person to resolve.
    //
    // It sits ABOVE step 5 in the spec's order and therefore applies to `replace` too: a
    // correction whose words are already in this space is a no-op, not a supersede. That
    // is the right answer for the case it actually meets — a re-issued tool call after a
    // retry — and the wrong-feeling one (two identical facts, one of them the target)
    // reaches the same terminal state either way.
    const dup = await findExactDuplicate(spaceId, a.statement, value, tx);
    if (dup) {
      return { status: "known", handle: ctx.handles.mint({ kind: "m", spaceId, nodeId: dup.id }), said: SAID.known };
    }

    // STEP 5 — SUPERSEDE ELIGIBILITY, and both conditions must hold.
    //
    // The second one reads the TURN's fold (`ctx.taint`), never a per-row check, and that
    // is the point of N2: the settled attack's vehicle is retrieved content sitting in the
    // context, so the bar is drawn at "did this turn read anything it did not author".
    // Rule 1's tie between statement and quote narrows that attack sharply and does not
    // close it — the predicate's documented blind spot is negation, and "Acme invoices are
    // NOT paid monthly" shares 100% of its long words with the user's own question about
    // whether they are. `longWords` filters words of three characters or fewer, so the
    // negation itself is not even weighed. The tie is a wording-overlap test and cannot be
    // a meaning test, which is why the clean bar is drawn at the attack's actual vehicle.
    //
    // Neither condition REFUSES. A correction that may not supersede is stored live at its
    // own class with `conflicts_with` pointing at the target, which is the single-reader
    // mechanism the person resolves on their page; the target row is untouched.
    let conflictReason: "weaker_class" | "untrusted_turn" | null = null;
    if (target) {
      conflictReason = !mayOutrank(verdict.sourceClass, target.sourceClass)
        ? "weaker_class"
        : ctx.taint.seen()
          ? "untrusted_turn"
          : null;
    }

    // STEP 6 — the topic, and the `contains` edge beside it, in THIS transaction. A blank
    // topic resolves to General rather than to nothing: a claim under no topic at all is
    // invisible to the note projection.
    const topic = await resolveTopic(spaceId, a.topic, tx, { resolveHandle: (h) => ctx.handles.resolve(h) });

    // The medium, not the tier. `origin.kind` deliberately does NOT reuse a `source_class`
    // name: `user_direct` being a value of two different enums in one argument list is the
    // LOW-6 mistake Task 1 exists to close, and the tier lives in its own column already.
    const origin: Record<string, unknown> = {
      kind: a.grounding.kind,
      messageId: ctx.messageId,
      taskId: ctx.taskId,
    };

    if (target && !conflictReason) {
      // STEP 7 — the superseding row is written at THE REPLACEMENT's class, never
      // inherited from the predecessor; `updateClaim` takes it as a required parameter.
      // STEP 8 — `expires_at` is armed inside that insert by `horizonFor(sourceClass)`, at
      // insert, by the writer, and from the class being stored rather than from `prev`.
      const upd = await updateClaim(
        {
          claimId: target.id,
          expectedRevision: target.revision,
          patch: {
            statement: a.statement,
            // `undefined` INHERITS the predecessor's value — the patch contract — which is
            // right when the model sent no `value_json`: a supersede asserts nothing about
            // a field it did not mention.
            value,
            // Only ever raised: `updateClaim` ORs it with the predecessor's under the row
            // lock, so passing `false` here cannot clear a flag.
            sensitive,
            origin,
            // A FALLBACK ONLY — applied when nothing carried over from the predecessor.
            // Silently moving a human-curated attachment would be worse than a successor
            // keeping the topic its predecessor had.
            topicNoteId: topic.id,
          },
          sourceClass: verdict.sourceClass,
          allowedSpaceIds: [spaceId],
          actor: ctx.actor,
        },
        tx,
      );
      // The CAS lost between the pre-check above and here. `current` is deliberately not
      // distinguished from "no longer there" by `claims.ts`, so the revision reported is
      // the one it could see.
      if (!upd.ok) {
        return {
          status: "revision_mismatch",
          revision: upd.current?.revision ?? target.revision,
          said: SAID.revision_mismatch,
        };
      }
      // THE CONVERSATION THIS FACT CAME OUT OF — see the create arm below. On this arm it
      // is the successor's own evidence and not the predecessor's carried over: the row is
      // new and its words were written in THIS turn, whatever the fact it replaces came
      // out of.
      await attachEvidence(upd.id, { messageId: ctx.messageId }, tx);
      return {
        status: "superseded",
        handle: ctx.handles.mint({ kind: "m", spaceId, nodeId: upd.id }),
        revision: upd.revision,
        sourceClass: verdict.sourceClass,
        said: SAID.superseded,
      };
    }

    // STEP 7 (the other arm) — a create, or a correction that may not supersede. Both are
    // NEW rows at their own class; the conflict carries a pointer and nothing else, and the
    // row it points at is not touched. STEP 8 is armed inside this insert too.
    const claim = await createClaim(
      {
        spaceId,
        statement: a.statement,
        value,
        origin,
        sensitive,
        sourceClass: verdict.sourceClass,
        topicNoteId: topic.id,
        createdTaskId: ctx.taskId,
        conflictsWith: target?.id,
        // AUDIT ONLY. It is on the write rather than on the return: see `SAID`.
        failedClause: verdict.failedClause,
      },
      ctx.actor,
      tx,
    );
    const handle = ctx.handles.mint({ kind: "m", spaceId, nodeId: claim.id });

    // THE CONVERSATION THIS FACT CAME OUT OF, and it is one line that was missing.
    //
    // `runExtraction` attaches it and this path did not, so a fact the model saved with
    // `memory_fact_write` — the WRITER this release steers every turn towards — arrived on
    // the memory page under "the conversation is no longer available", thirty seconds after
    // the person watched it be saved, on the one screen they can undo it from. Same
    // relation, same argument, same one call: `claim_evidence.message_id` is what lets the
    // page name the chat, and `ctx.messageId` is the turn that wrote the row.
    //
    // IN THE WRITE'S OWN TRANSACTION, so a fact and its provenance are one act. Evidence
    // for a claim that rolled back would be a row about content nobody stored.
    await attachEvidence(claim.id, { messageId: ctx.messageId }, tx);

    if (replacing && conflictReason) {
      return {
        status: "recorded_conflict",
        handle,
        conflictsWith: replacing.targetHandle,
        reason: conflictReason,
        sourceClass: verdict.sourceClass,
        said: conflictReason === "untrusted_turn" ? CONFLICT_UNTRUSTED_TURN : SAID.recorded_conflict,
      };
    }

    // `prompt_access` is READ BACK rather than computed: the column is generated, so the
    // value on this return is the database's own answer and not a second expression for it
    // written here. (The `accessOf` helper this comment used to name was DELETED in review
    // MED-2, along with the class→channel table inside it — there is nothing left to pin,
    // which is the point. `model-view.test.ts`'s `promptAccess` roster is what keeps this
    // file's only use of that vocabulary a read.) The head is the row this transaction just
    // wrote.
    const head = await findCurrentHead(claim.id, [spaceId], tx);
    // The row this transaction just wrote is unreadable from inside the same transaction:
    // that is not a status, it is a broken invariant, and rolling the write back is the
    // only honest answer to it.
    if (!head) throw new Error(`factWrite: claim ${claim.id} is not readable in its own transaction`);
    // WHICH DEVIATION THE MODEL IS TOLD ABOUT, when a create has more than one. The class
    // wins over the topic because it is the one the model cannot retry its way out of, and
    // nothing is lost either way: the topic sentence is appended below, and `sourceClass`
    // rides on every one of these returns.
    const status = verdict.downgraded ? "downgraded" : topic.state === "secret_fallback" ? "topic_secret_fallback" : "created";
    const filed =
      topic.state === "secret_fallback"
        ? SAID.topic_secret_fallback
        : `Filed under the ${topic.state === "created" ? "NEW" : "existing"} topic «${topic.title}».`;
    return {
      status,
      handle,
      revision: claim.revision,
      sourceClass: verdict.sourceClass,
      promptAccess: head.promptAccess,
      said: `${SAID[status]} ${filed}`,
    };
  });
}

/* ------------------------------------------------------------------------------------------
 * NOTES — `memory_note_write` and `memory_link` (§4.6, §4.8)
 * ---------------------------------------------------------------------------------------- */

export type NoteWriteStatus =
  | "created"
  | "updated"
  | "downgraded"
  | "topic_secret_fallback"
  | "revision_mismatch"
  | "refused_scope"
  | "refused_no_project"
  | "refused_weaker_class"
  | "refused_untrusted_turn"
  | "title_taken"
  | "retired"
  | "bad_handle";

/**
 * THE MODEL'S FEEDBACK ON A NOTE WRITE, and the two refusals are the interesting half.
 *
 * §4.6 says "scope, grounding, taint, conflict and `expires_at` rules are §4.5's, evaluated
 * in the same order", and a note CANNOT hold a conflict: `conflicts_with` is a `vault_claims`
 * column with a composite FK to a claim, and neither `vault_notes` nor
 * `vault_note_versions` has an equivalent. So the one arm §4.5 answers with
 * `recorded_conflict` — a correction that may not supersede — has nowhere to land here, and
 * a new revision IS a supersede: it replaces the head the manifest and every search read.
 *
 * Bound 4 of §10.1 is unconditional about that: an untrusted or weaker write "cannot
 * supersede a trusted claim — not at a weaker class, and not at ANY class in the turn that
 * read it". With no conflict row to degrade into, the only implementation of that bound for a
 * note is a REFUSAL, and both sentences therefore say what the model can do instead — write a
 * new note, which is additive and visible, and which it is not being stopped from doing.
 */
export const NOTE_SAID: Record<NoteWriteStatus, string> = {
  created: "Saved as a note.",
  updated: "Updated the note. The previous version is kept as history.",
  downgraded: "Saved, but not as something the user stated - recorded as your conclusion.",
  topic_secret_fallback: "The topic name looked like a credential, so it was filed under General instead.",
  revision_mismatch: "That note has moved on. Run memory_search and re-issue against what is there.",
  refused_scope:
    "A note based on a document or a web page cannot be saved as personal memory. Save it to the project, or write it as your own conclusion.",
  refused_no_project:
    "This chat is not inside a project, so there is no project memory to save to, and nowhere to store knowledge taken from documents or web pages. Nothing was saved.",
  refused_weaker_class:
    "That note carries more authority than this write does, so it was not changed. Write a new note instead and the user will see both.",
  refused_untrusted_turn:
    "This turn read a document or a web page, so an existing note cannot be rewritten in it. Nothing was changed - write a new note instead.",
  /** ONE SENTENCE FOR BOTH WRITERS. A whole-file update and a rename both send a title, so
   *  both can collide with `uniq_vnotes_topic_title`; two wordings for one circumstance would
   *  teach the model that the two calls fail for different reasons. */
  title_taken: "A file with that title already exists; open it and edit it instead.",
  retired: "This project's memory was deleted. Nothing was saved.",
  bad_handle: "That address is not from this conversation's search results. Run memory_search and use a handle it returned.",
};

/** The sentence an `untrusted_derived` note carries, and it is the one thing about a note
 *  write the model most needs to know: the note exists, it is findable, and it will not
 *  assert itself in a later chat.
 *
 *  §4.6's own example ends "— you will find it with knowledge_search". That half is NOT
 *  shipped here, for the reason `ABSENCE_NOTE` in `tools.ts` drops the same clause: naming a
 *  tool the turn does not hold teaches the model to report a search it could not run.
 *  `knowledge_search` is slice 3 and the clause joins this sentence with it. */
const UNTRUSTED_NOTE_NOTICE = "It will not be asserted in future chats on its own.";

export type NoteWriteResult =
  | {
      status: "created" | "updated" | "downgraded" | "topic_secret_fallback";
      handle: string;
      revision: number;
      /** Edges this write INSERTED. A link the previous revision already carried keeps its
       *  edge — and therefore its token, byte for byte — so it is not counted again. */
      linksCreated: number;
      /** The topic's HANDLE, never its id. ABSENT when the write filed nothing, which is an
       *  update that named no topic: omitted means "leave it where it is", so there is no
       *  topic this call can name — and a handle for whatever the note happened to be filed
       *  under would report a move this write did not make. A create always files. */
      filedUnder?: string;
      sourceClass: SourceClass;
      promptAccess: PromptAccess;
      said: string;
    }
  /** The CURRENT revision, and deliberately not the current title (§4.6 asks for both). A
   *  note title is model-facing text and `model-view.ts` owns every route to it; handing one
   *  back from a row this module read would be the twelfth instance of the defect that module
   *  exists to prevent. The revision is a number, which is what the model needs to re-issue.
   *  `memory_open` is the reader that may show the title (T12). */
  | { status: "revision_mismatch"; revision: number; said: string }
  | {
      status:
        | "refused_scope"
        | "refused_no_project"
        | "refused_weaker_class"
        | "refused_untrusted_turn"
        | "title_taken"
        | "retired"
        | "bad_handle";
      said: string;
    };

const badNoteHandle = (bad: string[]): NoteWriteResult => ({
  status: "bad_handle",
  said: `${NOTE_SAID.bad_handle} Unusable: ${bad.join(", ")}.`,
});

/**
 * A LINK TARGET, resolved to a node id in THIS space.
 *
 * `m` and `n` only: §2.4 runs `references` from a note to a note, a claim or a source, and an
 * `f` handle has no writer before slice 3 — so a target this slice can resolve is a fact or a
 * note. An `e` or a `g` handle is not a node at all.
 *
 * THE SPACE IS THE NOTE'S, not the caller's allowed list, and that is a fence rather than a
 * convenience: `vault_edges`' composite FKs make a cross-space edge unrepresentable, so a
 * foreign target would fail at the statement with a 23503 in the middle of a write — while
 * checking it here rejects the whole mutation with a sentence, before anything is written.
 * Both are the boundary; only one of them is an answer.
 */
async function linkTargetId(
  handle: string,
  ctx: WriteCtx,
  spaceId: string,
  ex: Ex,
): Promise<string | null> {
  const t = ctx.handles.resolve(handle);
  if (!t || t.spaceId !== spaceId) return null;
  if (t.kind === "m") return (await findCurrentHead(t.nodeId, [spaceId], ex))?.id ?? null;
  if (t.kind === "n") return (await noteHead(t.nodeId, [spaceId], ex))?.id ?? null;
  return null;
}

/**
 * `memory_note_write`, as §4.6 defines it — §4.5's nine steps, on a note.
 *
 * WHAT IS DELIBERATELY ABSENT, so nobody reads the shorter body as an oversight:
 *
 *   step 4 (dedup) — `normalized_hash` is a `vault_claims` column and there is no note
 *     equivalent. §8's automatic dedup covers topic titles, claims and file hashes, and a
 *     note body is none of those. Two notes saying the same thing is a §8 SUGGESTION, never
 *     a merge.
 *   step 5 (conflict) — see `NOTE_SAID`: a note cannot store a conflict, so both supersede
 *     conditions are refusals here.
 *   `sensitive` — no parameter, because §4.6 has none. `insertNoteVersion` screens the title
 *     and the body anyway, which is the same write-time screen the claim writers hold.
 */
export async function noteWrite(a: {
  op:
    | { kind: "create"; scope: "user" | "project" }
    | { kind: "update"; noteHandle: string; expectedRevision: number };
  title: string;
  content: NoteBlock[];
  grounding: GroundingInput;
  topic?: string;
  /** WHICH HEADING the owner's memory page files this under. Omitted means "leave it
   *  alone": a create takes the column's `'topic'` default, and an UPDATE that says nothing
   *  keeps whatever shelf the file is on — see `reviseNote` for why a defaulted parameter
   *  here would silently undo the person's own filing on every text edit. */
  section?: NoteSection;
  ctx: WriteCtx;
}): Promise<NoteWriteResult> {
  const { ctx } = a;
  const allowedSpaceIds = ctx.projectSpaceId ? [ctx.userSpaceId, ctx.projectSpaceId] : [ctx.userSpaceId];

  // Where this write lands, decided before a transaction is opened — the same shape, and the
  // same reasons, as `factWrite`'s. An update lands where the note it revises lives; it does
  // not get to choose, which is what makes step 3 cover both arms with one line.
  const updating = a.op.kind === "update" ? a.op : null;
  let spaceId: string;
  if (a.op.kind === "create") {
    if (a.op.scope === "project" && !ctx.projectSpaceId) {
      return { status: "refused_no_project", said: NOTE_SAID.refused_no_project };
    }
    spaceId = a.op.scope === "project" ? (ctx.projectSpaceId as string) : ctx.userSpaceId;
  } else {
    const t = ctx.handles.resolve(a.op.noteHandle);
    // `n` only: a claim is addressed by `memory_fact_write`, and answering a claim handle
    // with a note write would store prose where the model pointed at a fact.
    if (!t || t.kind !== "n" || !allowedSpaceIds.includes(t.spaceId)) return badNoteHandle([a.op.noteHandle]);
    spaceId = t.spaceId;
  }

  return db.transaction(async (tx): Promise<NoteWriteResult> => {
    // STEP 9, first statement, for the lock order every vault writer states.
    if (!(await spaceAcceptsWrites(spaceId, tx))) return { status: "retired", said: NOTE_SAID.retired };

    let head: Awaited<ReturnType<typeof noteHead>> = null;
    if (updating) {
      head = await noteHead(ctx.handles.resolve(updating.noteHandle)!.nodeId, [spaceId], tx);
      // Forgotten since the handle was minted. Not `revision_mismatch`: that status carries
      // "it is now at revision N", and there is no N.
      if (!head) return badNoteHandle([updating.noteHandle]);
      if (head.revision !== updating.expectedRevision) {
        return { status: "revision_mismatch", revision: head.revision, said: NOTE_SAID.revision_mismatch };
      }
    }

    // §4.1 for the LINK targets, before anything is decided and before anything is written.
    // A note is never saved with half its links.
    const targetIds = new Map<string, string>();
    const badTargets: string[] = [];
    for (const block of a.content) {
      if (block.kind !== "node_link" || targetIds.has(block.targetHandle)) continue;
      const id = await linkTargetId(block.targetHandle, ctx, spaceId, tx);
      if (id) targetIds.set(block.targetHandle, id);
      else badTargets.push(block.targetHandle);
    }
    if (badTargets.length) return badNoteHandle(badTargets);

    const resolved = await resolveGrounding(a.grounding, ctx, allowedSpaceIds, tx);
    if (!resolved.ok) return badNoteHandle(resolved.bad);

    // STEP 1 — the class. The statement clause 4 measures is the note's OWN words: its title
    // and its markdown blocks, which is what §4.6 means by "the same three-arm union" over a
    // note. A link block contributes no prose and is left out — a handle is an address, and
    // measuring it against the user's turn would dilute the overlap the clause exists to
    // require.
    const prose = [a.title, ...a.content.flatMap((b) => (b.kind === "markdown" ? [b.text] : []))].join("\n");
    const verdict = classify(resolved.grounding, {
      statement: prose,
      userTurnText: ctx.userTurnText,
      untrustedIngressSeen: ctx.taint.seen(),
    });

    // STEP 3 — THE FENCE, above every step below it, on `create` and `update` alike.
    if (verdict.sourceClass === "untrusted_derived" && spaceId === ctx.userSpaceId) {
      return ctx.projectSpaceId
        ? { status: "refused_scope", said: NOTE_SAID.refused_scope }
        : { status: "refused_no_project", said: NOTE_SAID.refused_no_project };
    }

    // STEP 5 — BOTH conditions, as refusals. See `NOTE_SAID` for why a note has no conflict
    // arm to degrade into, and §10.1 bound 4 for why neither condition is optional.
    if (head) {
      if (!mayOutrank(verdict.sourceClass, head.sourceClass)) {
        return { status: "refused_weaker_class", said: NOTE_SAID.refused_weaker_class };
      }
      if (ctx.taint.seen()) {
        return { status: "refused_untrusted_turn", said: NOTE_SAID.refused_untrusted_turn };
      }
    }

    // STEP 6 — the topic. Resolved before the note exists (it creates nothing about the
    // note) and attached after, because the `contains` edge needs both endpoints as rows.
    //
    // AN UPDATE THAT NAMES NO TOPIC FILES NOTHING, which is the same rule `section` holds:
    // omitted means "leave it where it is". Falling through with `undefined` resolves to
    // General, so every text edit of a note filed under something else added a SECOND
    // `contains` edge from General — invisible on the page, since notes are not listed under
    // their topic, and one more edge per update. A CREATE still always files: a note with no
    // container at all is the one case §4.6 does not leave open.
    const topic =
      updating && a.topic === undefined
        ? null
        : await resolveTopic(spaceId, a.topic, tx, { resolveHandle: (h) => ctx.handles.resolve(h) });

    const provenance: Record<string, unknown> = {
      kind: a.grounding.kind,
      messageId: ctx.messageId,
      taskId: ctx.taskId,
    };

    // THE WRITE ORDER IS FIXED (§4.6, §4.8) and the callback is where the middle of it lands:
    // node -> note shell -> the `references` edges -> serialize the blocks against their edge
    // ids -> the version -> the projection. An edge without its block would render a link the
    // note body does not mention; a block without its edge is §7's unresolved-text case,
    // which no tool may mint.
    let linksCreated = 0;
    const bodyFor = async (noteId: string): Promise<string> => {
      // An UPDATE replaces the whole body, so a link the new content drops is a link the note
      // no longer makes. Closed FIRST, so a re-linked target's live edge — and therefore its
      // token — survives untouched.
      if (updating) await unlinkReferencesFrom(noteId, spaceId, [...targetIds.values()], tx);
      const edgeIdFor = new Map<string, string>();
      for (const [handle, targetId] of targetIds) {
        const edge = await linkNodes(
          { spaceId, from: noteId, to: targetId, relation: "references", createdBy: ctx.actor, originMessageId: ctx.messageId },
          tx,
        );
        if (edge.created) linksCreated += 1;
        edgeIdFor.set(handle, edge.id);
      }
      return serializeBlocks(a.content, (h) => edgeIdFor.get(h) ?? "");
    };

    let noteId: string;
    let revision: number;
    if (updating && head) {
      // UNDER A SAVEPOINT, for the reason `noteEdit`'s rename gives at length: an update
      // sends a title too, so a topic container renamed onto a subject the space already has
      // raises 23505 at `reviseNote`'s first statement. Caught it is a sentence; uncaught it
      // poisons this transaction, and the caller gets a throw where a refusal belongs.
      const upd = await tx
        .transaction((sp) =>
          reviseNote(
            {
              noteId: head.id,
              spaceId,
              expectedRevision: head.revision,
              title: a.title,
              bodyMarkdown: bodyFor,
              section: a.section,
              sourceClass: verdict.sourceClass,
              provenance,
              createdTaskId: ctx.taskId,
              actor: ctx.actor,
            },
            sp,
          ),
        )
        .catch((e: unknown) => {
          if (!isTitleFoldConflict(e)) throw e;
          return "title_taken" as const;
        });
      if (upd === "title_taken") return { status: "title_taken", said: NOTE_SAID.title_taken };
      // The CAS lost between the pre-check above and the statement. Nothing was written —
      // including no edges, which is why the callback runs after the CAS and not before it.
      if (!upd.ok) {
        return { status: "revision_mismatch", revision: upd.currentRevision, said: NOTE_SAID.revision_mismatch };
      }
      noteId = head.id;
      revision = upd.revision;
    } else {
      const created = await createNote(
        {
          spaceId,
          title: a.title,
          bodyMarkdown: bodyFor,
          section: a.section,
          sourceClass: verdict.sourceClass,
          provenance,
          createdTaskId: ctx.taskId,
          actor: ctx.actor,
        },
        tx,
      );
      noteId = created.id;
      revision = created.revision;
    }

    // The topic's `contains` edge, in THIS transaction, and only when this write named a
    // topic. Idempotent, so a re-filed note on an update keeps the one edge it had. No
    // `note_claims` row: that table links a topic to CLAIMS and cannot represent a topic
    // containing a note, which is also why `containsParity` scopes its edge side to claim
    // targets.
    if (topic) {
      await linkNodes(
        { spaceId, from: topic.id, to: noteId, relation: "contains", createdBy: ctx.actor, originMessageId: ctx.messageId },
        tx,
      );
    }

    // Read back rather than computed, exactly as `factWrite` reads `prompt_access`: the
    // column is generated, and the head is the version this transaction just wrote.
    const written = await noteHead(noteId, [spaceId], tx);
    if (!written) throw new Error(`noteWrite: note ${noteId} is not readable in its own transaction`);

    const status: NoteWriteStatus = verdict.downgraded
      ? "downgraded"
      : topic?.state === "secret_fallback"
        ? "topic_secret_fallback"
        : updating
          ? "updated"
          : "created";
    // Nothing at all when this write filed nothing: a sentence naming a topic it did not
    // touch would be the tool reporting a move that did not happen.
    const filed = !topic
      ? ""
      : topic.state === "secret_fallback"
        ? NOTE_SAID.topic_secret_fallback
        : `Filed under the ${topic.state === "created" ? "NEW" : "existing"} topic «${topic.title}».`;
    const notice = verdict.sourceClass === "untrusted_derived" ? ` ${UNTRUSTED_NOTE_NOTICE}` : "";
    return {
      status,
      handle: ctx.handles.mint({ kind: "n", spaceId, nodeId: noteId }),
      revision,
      linksCreated,
      ...(topic ? { filedUnder: ctx.handles.mint({ kind: "n", spaceId, nodeId: topic.id }) } : {}),
      sourceClass: verdict.sourceClass,
      promptAccess: written.promptAccess,
      said: `${NOTE_SAID[status]}${filed ? ` ${filed}` : ""}${notice}`,
    };
  });
}

/**
 * EDITING A MEMORY FILE IN PLACE — `str_replace`, `insert`, `rename`, modelled on Claude's
 * own memory tool, which is the surface the model already knows.
 *
 * WHY IT IS NOT `update`. `noteWrite`'s update arm replaces the whole file: to change one
 * sentence the model has to re-send every other sentence, which costs a whole body of
 * output tokens and is how a paragraph silently disappears — the model drops it while
 * retyping and nothing in the write can tell that from an intentional deletion. An edit
 * names only what changes, so what it did not name cannot be lost.
 *
 * THE MODEL EDITS WHAT IT SAW. `memory_open` renders canonical edge tokens as their
 * targets' current titles, so `old_str` arrives in RENDERED form and is mapped back before
 * it is matched (`note-edit.ts`). The titles it is mapped through come from
 * `openNoteForModel` — the same mint that produced the text the model read — because which
 * titles a channel admits is `model-view.ts`'s decision and must not be answered twice.
 *
 * THE FENCE IS §4.5'S, NOT A SOFTER ONE. A new revision IS a supersede: it replaces the head
 * the manifest and every search read, and §10.1 bound 4 does not care that the edit was
 * small. So step 3 refuses `untrusted_derived` into the user space, and step 5 refuses both
 * a weaker class and any edit in a turn that read a document. The revision that lands
 * carries the verdict's class FOR THE WHOLE FILE — one file, one class per revision. There
 * is no way to mark a paragraph as weaker than the file it sits in, and inventing one here
 * would make `prompt_access` a property of a span rather than of a row; a weaker write is
 * therefore refused rather than blended in.
 *
 * `sensitive` and the secret screen are `insertNoteVersion`'s, over the whole new body, so
 * an edit that pastes a credential into a clean file marks the file exactly as a rewrite
 * would.
 */
export type NoteEditOp =
  | { kind: "str_replace"; noteHandle: string; expectedRevision: number; oldStr: string; newStr: string }
  | { kind: "insert"; noteHandle: string; expectedRevision: number; insertLine: number; insertText: string }
  | { kind: "rename"; noteHandle: string; expectedRevision: number; title: string };

export type NoteEditStatus =
  | "edited"
  | "renamed"
  | "no_match"
  | "ambiguous_match"
  | "bad_line"
  | "ambiguous_link"
  | "bad_link"
  | "too_long"
  | "title_taken"
  | "not_readable"
  /** Shared with `noteWrite`, and answered with ITS sentence: the circumstance is the same
   *  one and a second wording for it would teach the model that an edit and a rewrite fail
   *  for different reasons. */
  | "revision_mismatch"
  | "refused_scope"
  | "refused_no_project"
  | "refused_weaker_class"
  | "refused_untrusted_turn"
  | "retired"
  | "bad_handle";

/**
 * THE EDIT-ONLY SENTENCES, beside `NOTE_SAID` rather than inside it.
 *
 * Three of these have to name a NUMBER the model does not otherwise have — the revision the
 * match failed against, the lines a duplicate sits on, the legal range for `insert_line` —
 * and a `Record<Status, string>` cannot carry one. Keeping those three as templates next to
 * the static ones is the alternative to storing each sentence twice, once with the number
 * and once without, which is a drift waiting to happen.
 *
 * The wording follows Anthropic's own text-editor tool where there is an equivalent, on
 * purpose: the model has seen these sentences before and knows what to do about them.
 */
export const NOTE_EDIT_SAID = {
  edited: "The memory file has been edited.",
  renamed: "The file has been renamed. Its text is unchanged.",
  bad_link:
    "Links are not typed into a file. Add one with a node_link block in memory_note_write, or with memory_link.",
  /** THE SECOND SENTENCE UNDER ONE STATUS, and the only place in this table that happens.
   *  Both are `bad_link`: the edit is wrong about a link either way, which is what the status
   *  is for. But the two are wrong in opposite directions — one invents a link, one destroys
   *  half of one — and the advice cannot be shared, because "do not type links" says nothing
   *  useful to a model that was trying to delete a sentence next to one. */
  split_link: "That edit would cut through a link. Select the whole [[link]] in old_str, or leave it out.",
  too_long:
    "That would make the file longer than a memory file may be. Start a second file with memory_note_write op create.",
  title_taken: NOTE_SAID.title_taken,
  not_readable:
    "That file is not readable as memory, so its text cannot be edited here. Tell the user it is on their memory page.",
} satisfies Record<string, string>;

const saidNoMatch = (revision: number) =>
  `No replacement was performed, old_str did not appear verbatim in the current version (revision ${revision}). Open the note again with memory_open and copy the text exactly.`;

const saidAmbiguousMatch = (lines: number[]) =>
  `No replacement was performed. Multiple occurrences of old_str in lines: ${lines.join(", ")}. Include more context so it matches once.`;

const saidBadLine = (given: number, lines: number) =>
  `Invalid \`insert_line\` parameter: ${given}. It should be within the range of lines of the file: [0, ${lines}]`;

const saidAmbiguousLink = (title: string) =>
  `Two links in this file both show as «${title}», so that text could mean either one. Edit around it, or rewrite the file with memory_note_write.`;

export type NoteEditResult =
  | {
      status: "edited" | "renamed";
      handle: string;
      revision: number;
      sourceClass: SourceClass;
      /** How many `references` edges this edit closed, because the text stopped mentioning
       *  them. Present on an edit and absent on a rename, which touches no body. */
      linksRemoved?: number;
      said: string;
    }
  | { status: "revision_mismatch"; revision: number; said: string }
  | {
      status: Exclude<NoteEditStatus, "edited" | "renamed" | "revision_mismatch">;
      said: string;
    };

const badEditHandle = (handle: string): NoteEditResult => ({
  status: "bad_handle",
  said: `${NOTE_SAID.bad_handle} Unusable: ${handle}.`,
});

/** How many lines of the file to show on either side of the change, so the model can see
 *  that the edit landed where it meant it to without spending a second `memory_open`. */
const SNIPPET_CONTEXT = 4;

/**
 * WHAT THE FILE LOOKS LIKE AROUND THE CHANGE, numbered exactly as `memory_open` numbers it.
 *
 * It goes through `openNoteForModel` — a second call, after the write, inside the same
 * transaction — rather than being composed from the body this module just computed. The
 * body is a stored string full of edge tokens; turning it into something a model may read
 * is a mint, and §3.4's NEW-3 is that there is one of those per channel and it lives in
 * `model-view.ts`. The second call also answers a question the writer cannot: whether the
 * new text tripped the secret screen, in which case there is no snippet to show and the
 * reply says only that the edit landed.
 *
 * IT COSTS A SECOND `last_used_at` STAMP, and that is accepted rather than overlooked.
 * `openNoteForModel` stamps unconditionally because the stamp means "the model received this
 * row", and on this path it did — twice in one turn, which is the same answer to the question
 * the column asks. Suppressing it would need a flag on the mint, and a mint with a "do not
 * record that you were read" mode is a worse thing to own than one redundant timestamp.
 */
async function editSnippet(
  spaceId: string,
  noteId: string,
  changed: { from: number; to: number },
  ex: Ex,
): Promise<string> {
  const view = await openNoteForModel(spaceId, noteId, ex);
  if (!view.ok) return "";
  const lines = view.item.body === "" ? [] : view.item.body.split("\n");
  const first = Math.max(1, changed.from - SNIPPET_CONTEXT);
  const last = Math.min(lines.length, changed.to + SNIPPET_CONTEXT);
  if (last < first) return "";
  const shown = lines.slice(first - 1, last).map((text, i) => numberLine(first + i, text));
  // CLAMPED, because nothing bounds one LINE of a note and this reply lands AFTER the write
  // has committed. The turn's vault budget is sticky: one oversize reply and every later
  // memory call in the turn gets the exhausted sentence, so the model is told memory is
  // unavailable for an edit that actually landed, and cannot re-open the file to check.
  //
  // The cut is `memory_open`'s — whole lines while they fit, and a UTF-8 boundary when even
  // the first will not — written out rather than borrowed from `pageLines`, because these
  // lines already carry the FILE's numbers and paging them again would number them twice.
  const kept: string[] = [];
  let spent = 0;
  for (const line of shown) {
    const size = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (spent + size > EDIT_SNIPPET_MAX_BYTES) break;
    kept.push(line);
    spent += size;
  }
  if (!kept.length) {
    const buf = Buffer.from(shown[0], "utf8");
    let end = EDIT_SNIPPET_MAX_BYTES;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
    kept.push(buf.subarray(0, end).toString("utf8"));
  }
  const cut = kept.length < shown.length || kept[0] !== shown[0];
  return `\n${kept.join("\n")}${cut ? "\n... (snippet cut; memory_open for the rest)" : ""}`;
}

/** A refusal from the pure editor, in the tool's own vocabulary. Written as one place so a
 *  new refusal in `note-edit.ts` is a compile error here rather than a silent fall-through
 *  to some default sentence. */
function editRefusal(r: Exclude<EditResult, { ok: true }>, revision: number, given: number): NoteEditResult {
  switch (r.reason) {
    case "no_match":
      return { status: "no_match", said: saidNoMatch(revision) };
    case "ambiguous_match":
      return { status: "ambiguous_match", said: saidAmbiguousMatch(r.lines) };
    case "bad_line":
      return { status: "bad_line", said: saidBadLine(given, r.lines) };
    case "ambiguous_link":
      return { status: "ambiguous_link", said: saidAmbiguousLink(r.title) };
    case "bad_link":
      return { status: "bad_link", said: NOTE_EDIT_SAID.bad_link };
    case "split_link":
      return { status: "bad_link", said: NOTE_EDIT_SAID.split_link };
  }
}

export async function noteEdit(a: {
  op: NoteEditOp;
  grounding: GroundingInput;
  /** As `noteWrite`'s: omitted leaves the file on the shelf the person put it on. An edit
   *  that says nothing about the heading must not move the file. */
  section?: NoteSection;
  ctx: WriteCtx;
}): Promise<NoteEditResult> {
  const { ctx, op } = a;
  const allowedSpaceIds = ctx.projectSpaceId ? [ctx.userSpaceId, ctx.projectSpaceId] : [ctx.userSpaceId];
  const t = ctx.handles.resolve(op.noteHandle);
  // `n` only. A claim is edited with `memory_fact_write`, which supersedes it rather than
  // rewriting it — a fact has one sentence and no lines to address.
  if (!t || t.kind !== "n" || !allowedSpaceIds.includes(t.spaceId)) return badEditHandle(op.noteHandle);
  const spaceId = t.spaceId;

  return db.transaction(async (tx): Promise<NoteEditResult> => {
    // STEP 9, first statement, for the lock order every vault writer states.
    if (!(await spaceAcceptsWrites(spaceId, tx))) return { status: "retired", said: NOTE_SAID.retired };

    const head = await noteHead(t.nodeId, [spaceId], tx);
    // Forgotten since the handle was minted. Not `revision_mismatch`: that status carries
    // "it is now at revision N", and there is no N.
    if (!head) return badEditHandle(op.noteHandle);
    if (head.revision !== op.expectedRevision) {
      return { status: "revision_mismatch", revision: head.revision, said: NOTE_SAID.revision_mismatch };
    }

    // STEP 1 — the class, measured against THE WORDS THIS EDIT ADDS and not against the
    // file it adds them to. Clause 4 asks whether the statement is made of what the user
    // said; measuring the whole body would let one quoted sentence carry a file the user
    // never saw, and measuring nothing at all would make every edit an inference.
    //
    // IT RUNS BEFORE THE FILE IS READ, and that ordering is the fence's. Every refusal
    // below is about AUTHORITY, and one of them — a file this channel may not read at all —
    // is about visibility; answering the visibility one first would let "I cannot show you
    // this file" stand in front of "you may not change this file", which is the weaker
    // answer to the more serious question. The words this edit adds are known without
    // opening anything, so nothing is lost by deciding the class first.
    const written = op.kind === "rename" ? op.title : op.kind === "str_replace" ? op.newStr : op.insertText;
    const resolved = await resolveGrounding(a.grounding, ctx, allowedSpaceIds, tx);
    if (!resolved.ok) return badEditHandle(resolved.bad.join(", "));
    const verdict = classify(resolved.grounding, {
      statement: written,
      userTurnText: ctx.userTurnText,
      untrustedIngressSeen: ctx.taint.seen(),
    });

    // STEP 3 — THE FENCE, above every step below it.
    if (verdict.sourceClass === "untrusted_derived" && spaceId === ctx.userSpaceId) {
      return ctx.projectSpaceId
        ? { status: "refused_scope", said: NOTE_SAID.refused_scope }
        : { status: "refused_no_project", said: NOTE_SAID.refused_no_project };
    }

    // STEP 5 — BOTH conditions, as refusals, because an edit supersedes a head exactly as a
    // rewrite does. See `noteWrite`'s `NOTE_SAID` for why a note has no conflict arm.
    if (!mayOutrank(verdict.sourceClass, head.sourceClass)) {
      return { status: "refused_weaker_class", said: NOTE_SAID.refused_weaker_class };
    }
    if (ctx.taint.seen()) {
      return { status: "refused_untrusted_turn", said: NOTE_SAID.refused_untrusted_turn };
    }

    // AFTER the fence and before anything is read or written: one edit may not carry more
    // text than a couple of the blocks a whole write is made of.
    if (written.length > 2 * NOTE_BLOCK_MAX_CHARS) {
      return { status: "too_long", said: NOTE_EDIT_SAID.too_long };
    }

    let title = head.title;
    let body = head.bodyMarkdown;
    let linksRemoved: string[] = [];
    let changed: { from: number; to: number } | null = null;

    if (op.kind === "rename") {
      title = op.title;
    } else {
      const view = await openNoteForModel(spaceId, head.id, tx);
      // The model holds a handle to a file its channel may not read — a note the secret
      // screen marked, most likely. It cannot have copied text out of it, so there is
      // nothing here for `old_str` to have come from.
      if (!view.ok) return { status: "not_readable", said: NOTE_EDIT_SAID.not_readable };
      const r =
        op.kind === "str_replace"
          ? applyStrReplace({
              storedBody: head.bodyMarkdown,
              edges: view.item.tokenTitles,
              oldStr: op.oldStr,
              newStr: op.newStr,
            })
          : applyInsert({ storedBody: head.bodyMarkdown, insertLine: op.insertLine, insertText: op.insertText });
      if (!r.ok) return editRefusal(r, head.revision, op.kind === "insert" ? op.insertLine : 0);
      body = r.body;
      linksRemoved = r.linksRemoved;
      changed = { from: r.changedFrom, to: r.changedTo };
    }

    // The other half of the bound: a file may not be grown past what the schema lets a whole
    // write store, one insert at a time.
    if (body.length > NOTE_BLOCKS_MAX * NOTE_BLOCK_MAX_CHARS) {
      return { status: "too_long", said: NOTE_EDIT_SAID.too_long };
    }

    // A RENAME RUNS UNDER A SAVEPOINT, because the title is the one field a note write can
    // be REFUSED for at the statement: `uniq_vnotes_topic_title` makes a topic container's
    // subject unique per space, and `reviseNote`'s first statement is what raises the 23505.
    // Caught here it becomes a sentence; uncaught it poisons the whole transaction — and a
    // savepoint is what lets the caller's transaction survive the attempt at all.
    //
    // ONLY a topic container can collide. There is no unique index over a plain note's
    // title, on purpose: two files may legitimately be called the same thing, and only a
    // heading on the person's own page has to be unique. A rename NEVER overwrites the file
    // it collides with — the reply points the model at that file instead.
    const revise = (ex: Ex) =>
      reviseNote(
        {
          noteId: head.id,
          spaceId,
          expectedRevision: head.revision,
          title,
          // AFTER the CAS, which is what the callback shape buys: a lost race must close no
          // edges. §4.8 is symmetric — a token the new body no longer carries is a link the
          // file no longer makes, and an edge that outlives its token renders one it does not.
          bodyMarkdown: async () => {
            for (const edgeId of linksRemoved) await unlinkEdge(edgeId, spaceId, ex);
            return body;
          },
          section: a.section,
          sourceClass: verdict.sourceClass,
          // `edit` is what tells the chat notice's Undo, and anyone reading the audit log,
          // that this revision changed part of a file rather than replacing it. The rest is
          // the shape every other note write stores, which is what keeps `readTurnWrites`
          // naming this note once with the new revision and `revertNote` able to undo it.
          provenance: { kind: a.grounding.kind, edit: op.kind, messageId: ctx.messageId, taskId: ctx.taskId },
          createdTaskId: ctx.taskId,
          actor: ctx.actor,
        },
        ex,
      );

    const upd =
      op.kind === "rename"
        ? await tx
            .transaction((sp) => revise(sp))
            .catch((e: unknown) => {
              if (!isTitleFoldConflict(e)) throw e;
              return "title_taken" as const;
            })
        : await revise(tx);
    if (upd === "title_taken") return { status: "title_taken", said: NOTE_EDIT_SAID.title_taken };
    // The CAS lost between the pre-check above and the statement. Nothing was written —
    // including no closed edges, which is why the callback runs after the CAS.
    if (!upd.ok) {
      return { status: "revision_mismatch", revision: upd.currentRevision, said: NOTE_SAID.revision_mismatch };
    }

    const handle = ctx.handles.mint({ kind: "n", spaceId, nodeId: head.id });
    if (op.kind === "rename") {
      return {
        status: "renamed",
        handle,
        revision: upd.revision,
        sourceClass: verdict.sourceClass,
        said: NOTE_EDIT_SAID.renamed,
      };
    }
    const dropped = linksRemoved.length ? ` ${linksRemoved.length} link${linksRemoved.length > 1 ? "s" : ""} the text no longer mentions ${linksRemoved.length > 1 ? "were" : "was"} removed with it.` : "";
    return {
      status: "edited",
      handle,
      revision: upd.revision,
      sourceClass: verdict.sourceClass,
      linksRemoved: linksRemoved.length,
      said: `${NOTE_EDIT_SAID.edited}${dropped}${await editSnippet(spaceId, head.id, changed!, tx)}`,
    };
  });
}

export type MemoryLinkStatus =
  | "linked"
  | "already_linked"
  | "revision_mismatch"
  | "refused_weaker_class"
  | "refused_untrusted_turn"
  | "retired"
  | "bad_handle";

export type MemoryLinkResult =
  | { status: "linked"; edgeHandle: string; revision: number; said: string }
  | { status: "already_linked"; edgeHandle: string; revision: number; said: string }
  | { status: "revision_mismatch"; revision: number; said: string }
  | { status: "refused_weaker_class" | "refused_untrusted_turn" | "retired" | "bad_handle"; said: string };

/**
 * `memory_link` (§4.8): a `references` edge AND its canonical link block, through a new note
 * revision, in ONE transaction.
 *
 * Both halves or neither. An edge without its block would render a link the note body does
 * not mention; a block without its edge is §7's unresolved-text case and must not be minted
 * by a tool. That is why this is not "add an edge" with a body update bolted on: the body is
 * computed inside the revision's own CAS, so a lost race writes no edge either.
 *
 * A note revision is a supersede of the head, so §4.5 step 5's two conditions apply exactly
 * as they do to `memory_note_write`'s update arm — see `NOTE_SAID`.
 */
export async function memoryLink(a: {
  fromNoteHandle: string;
  targetHandle: string;
  expectedNoteRevision: number;
  ctx: WriteCtx;
}): Promise<MemoryLinkResult> {
  const { ctx } = a;
  const allowedSpaceIds = ctx.projectSpaceId ? [ctx.userSpaceId, ctx.projectSpaceId] : [ctx.userSpaceId];
  const from = ctx.handles.resolve(a.fromNoteHandle);
  if (!from || from.kind !== "n" || !allowedSpaceIds.includes(from.spaceId)) {
    return { status: "bad_handle", said: `${NOTE_SAID.bad_handle} Unusable: ${a.fromNoteHandle}.` };
  }
  const spaceId = from.spaceId;

  return db.transaction(async (tx): Promise<MemoryLinkResult> => {
    if (!(await spaceAcceptsWrites(spaceId, tx))) return { status: "retired", said: NOTE_SAID.retired };

    const head = await noteHead(from.nodeId, [spaceId], tx);
    if (!head) return { status: "bad_handle", said: `${NOTE_SAID.bad_handle} Unusable: ${a.fromNoteHandle}.` };
    if (head.revision !== a.expectedNoteRevision) {
      return { status: "revision_mismatch", revision: head.revision, said: NOTE_SAID.revision_mismatch };
    }

    const targetId = await linkTargetId(a.targetHandle, ctx, spaceId, tx);
    if (!targetId) return { status: "bad_handle", said: `${NOTE_SAID.bad_handle} Unusable: ${a.targetHandle}.` };
    if (targetId === head.id) {
      // `ck_vault_edges_not_self` would refuse this at the statement, mid-transaction. A
      // sentence is the better answer to the same fact.
      return { status: "bad_handle", said: `${NOTE_SAID.bad_handle} A note cannot link to itself.` };
    }

    // The class of a link revision: the AGENT is adding the link, so there is nothing to
    // ground it on and `agent_inference` is the honest arm — floored at `untrusted_derived`
    // by a tainted turn, which the fence below then refuses outright.
    const verdict = classify(
      { kind: "agent_inference" },
      { statement: head.title, userTurnText: ctx.userTurnText, untrustedIngressSeen: ctx.taint.seen() },
    );
    if (!mayOutrank(verdict.sourceClass, head.sourceClass)) {
      return { status: "refused_weaker_class", said: NOTE_SAID.refused_weaker_class };
    }
    if (ctx.taint.seen()) {
      return { status: "refused_untrusted_turn", said: NOTE_SAID.refused_untrusted_turn };
    }

    // ALREADY LINKED writes nothing at all — not a second block for one edge, and not a
    // revision whose only change is a duplicate. `uniq_live_vault_edge` makes the edge
    // idempotent; the BODY is not, so the check has to be here and not left to the insert.
    const existing = await liveReferenceEdge(head.id, targetId, spaceId, tx);
    if (existing) {
      return {
        status: "already_linked",
        edgeHandle: ctx.handles.mint({ kind: "g", spaceId, nodeId: existing }),
        revision: head.revision,
        said: "That link is already there - nothing to do.",
      };
    }

    let edgeId = "";
    const upd = await reviseNote(
      {
        noteId: head.id,
        spaceId,
        expectedRevision: head.revision,
        title: head.title,
        bodyMarkdown: async (noteId) => {
          const edge = await linkNodes(
            { spaceId, from: noteId, to: targetId, relation: "references", createdBy: ctx.actor, originMessageId: ctx.messageId },
            tx,
          );
          edgeId = edge.id;
          return appendLinkBlock(head.bodyMarkdown, edge.id);
        },
        sourceClass: verdict.sourceClass,
        provenance: { kind: "link", messageId: ctx.messageId, taskId: ctx.taskId },
        createdTaskId: ctx.taskId,
      },
      tx,
    );
    if (!upd.ok) {
      return { status: "revision_mismatch", revision: upd.currentRevision, said: NOTE_SAID.revision_mismatch };
    }
    return {
      status: "linked",
      // A `g` handle addresses an EDGE, which is the one handle kind that is not a node —
      // `nodeId` carries the edge id here, as `handles.ts` says it does for `g`.
      edgeHandle: ctx.handles.mint({ kind: "g", spaceId, nodeId: edgeId }),
      revision: upd.revision,
      said: "Linked. The note now mentions it, and renaming either one keeps the link.",
    };
  });
}

/** Whether these two nodes already carry a live `references` edge. A read, so it lives beside
 *  its one caller rather than in `edges.ts`: that module owns the WRITES and their inverses,
 *  and a lookup that exists only to keep one body from gaining a duplicate block is this
 *  tool's business, not the graph's. */
async function liveReferenceEdge(from: string, to: string, spaceId: string, ex: Ex): Promise<string | null> {
  const [row] = await ex
    .select({ id: vaultEdges.id })
    .from(vaultEdges)
    .where(
      and(
        eq(vaultEdges.spaceId, spaceId),
        eq(vaultEdges.fromNodeId, from),
        eq(vaultEdges.toNodeId, to),
        eq(vaultEdges.relation, "references"),
        isNull(vaultEdges.deletedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/* ------------------------------------------------------------------------------------------
 * FILING — `memory_file` (§4.7)
 * ---------------------------------------------------------------------------------------- */

export type MemoryFileStatus =
  | "filed"
  | "not_found"
  | "revision_mismatch"
  | "wrong_scope"
  | "wrong_kind"
  | "retired";

/**
 * §4.7's four explicit errors, and the `wrong_kind` sentence NAMES THE RIGHT TOOL.
 *
 * `contains` runs topic -> note | claim (§2.4), so an `f` handle is not a thing that can be
 * filed: a document is LINKED to a note. Answering it with an out-of-domain edge would put a
 * row in `vault_edges` that `linkNodes`' own pair check exists to refuse, and answering it
 * with a bare "no" would leave the model to guess which of five tools it wanted.
 */
export const FILE_SAID: Record<MemoryFileStatus, string> = {
  filed: "Filed.",
  not_found: "That address is not from this conversation's search results, or the item is no longer there. Run memory_search and use a handle it returned.",
  revision_mismatch: "That item has moved on. Run memory_search and re-issue against what is there.",
  wrong_scope: "A topic and the item filed under it have to be in the same memory - personal or this project, not one of each.",
  wrong_kind: "A document is linked to a note, not filed under a topic - use memory_link.",
  retired: "This project's memory was deleted. Nothing was saved.",
};

/** The `wrong_kind` arm for a handle that is not a NODE at all. `e` and `g` are the two
 *  letters with no row a `contains` edge could name, and they get a different sentence for
 *  the same reason `f` gets its own: a refusal that does not say what the thing IS teaches
 *  the model to retry with the same handle. */
const FILE_NOT_A_NODE = "A fragment and a link are not items that can be filed - file the note or the fact they belong to.";

/** The topic arm's own `wrong_kind`: a live note that is not a topic container. Separate
 *  from the `f` sentence because the bad handle is the OTHER argument, and a refusal naming
 *  the wrong parameter is worse than a vague one. */
const FILE_NOT_A_TOPIC = "That handle is a note, not a topic. Name a topic by its subject in memory_fact_write, or file this under one memory_search returned as a topic.";

export type MemoryFileResult =
  | { status: "filed"; edgeHandle: string; said: string }
  | { status: "revision_mismatch"; revision: number; said: string }
  | { status: "not_found" | "wrong_scope" | "wrong_kind" | "retired"; said: string };

/**
 * `memory_file` (§4.7): one `contains` edge, from a topic to a fact or a note.
 *
 * `expected_item_revision` is REQUIRED and is checked (M17): an optional CAS parameter is an
 * optional CAS. It is not a CAS in the `updateClaim` sense — nothing about the item's content
 * changes — but the model asked to file THE THING IT READ, and a fact superseded since then
 * is a different sentence under the same address.
 *
 * NO CLASS FENCE, and its absence is a decision. Filing writes no text and changes no
 * authority: `listManifestTopics`' count is `prompt_access = 'manifest'` claims only, so
 * filing an untrusted fact under a topic adds nothing to the always-on tier, and an untrusted
 * row cannot be in a user space in the first place (§4.5 step 3). What the edge does is make
 * the item visible in a grouping the person curates, which is additive and undoable.
 *
 * CROSS-SPACE FILING IS IMPOSSIBLE AT THE FOREIGN KEY — `vault_edges`' two composite FKs to
 * `(space_id, id)` — so the check below is a nicer error message and not the boundary.
 */
export async function memoryFile(a: {
  itemHandle: string;
  topicHandle: string;
  expectedItemRevision: number;
  ctx: WriteCtx;
}): Promise<MemoryFileResult> {
  const { ctx } = a;
  const allowedSpaceIds = ctx.projectSpaceId ? [ctx.userSpaceId, ctx.projectSpaceId] : [ctx.userSpaceId];
  const item = ctx.handles.resolve(a.itemHandle);
  if (!item || !allowedSpaceIds.includes(item.spaceId)) return { status: "not_found", said: FILE_SAID.not_found };
  // `m` and `n` ONLY (§4.7). The two refusals are different sentences because the two
  // circumstances are: a document has a tool that DOES link it, and a fragment or an edge has
  // no row a `contains` edge could point at.
  if (item.kind === "f") return { status: "wrong_kind", said: FILE_SAID.wrong_kind };
  if (item.kind !== "m" && item.kind !== "n") return { status: "wrong_kind", said: FILE_NOT_A_NODE };

  const topic = ctx.handles.resolve(a.topicHandle);
  if (!topic || !allowedSpaceIds.includes(topic.spaceId)) return { status: "not_found", said: FILE_SAID.not_found };
  if (topic.kind !== "n") {
    return { status: "wrong_kind", said: topic.kind === "f" ? FILE_SAID.wrong_kind : FILE_NOT_A_NODE };
  }
  if (topic.spaceId !== item.spaceId) return { status: "wrong_scope", said: FILE_SAID.wrong_scope };
  if (topic.nodeId === item.nodeId) {
    // `ck_vault_edges_not_self` would refuse this at the statement, mid-transaction.
    return { status: "wrong_kind", said: FILE_NOT_A_TOPIC };
  }
  const spaceId = item.spaceId;

  return db.transaction(async (tx): Promise<MemoryFileResult> => {
    if (!(await spaceAcceptsWrites(spaceId, tx))) return { status: "retired", said: FILE_SAID.retired };

    const revision =
      item.kind === "m"
        ? (await findCurrentHead(item.nodeId, [spaceId], tx))?.revision
        : (await noteHead(item.nodeId, [spaceId], tx))?.revision;
    if (revision === undefined) return { status: "not_found", said: FILE_SAID.not_found };
    if (revision !== a.expectedItemRevision) {
      return { status: "revision_mismatch", revision, said: FILE_SAID.revision_mismatch };
    }

    // A LIVE TOPIC CONTAINER, read rather than assumed: `resolveTopic`'s handle arm asks the
    // same question of the same three columns, and for the same reason — a handle says the
    // LETTER of its target and nothing about the row's kind.
    //
    // THE TITLE READ HERE IS INTERPOLATED INTO A MODEL-FACING SENTENCE BELOW, outside
    // `model-view.ts`, and two facts are what make that legal rather than an exception:
    // `resolveTopic` SECRET-SCREENS a topic title before a container can be created with
    // one, so no stored `memory_topic` title is secret-shaped; and nothing in this slice
    // revises a `memory_topic` version, so the title cannot become one afterwards. The day
    // either changes — a topic rename, or any writer of a topic BODY — this read has to go
    // through a mint, and so do `resolveTopic`'s two row-read arms.
    const [container] = await tx
      .select({ id: vaultNotes.id, title: vaultNotes.title, kind: vaultNotes.kind })
      .from(vaultNotes)
      .innerJoin(vaultNodes, eq(vaultNodes.id, vaultNotes.id))
      .where(and(eq(vaultNotes.id, topic.nodeId), eq(vaultNotes.spaceId, spaceId), isNull(vaultNodes.deletedAt)))
      .limit(1);
    if (!container) return { status: "not_found", said: FILE_SAID.not_found };
    if (container.kind !== "memory_topic") return { status: "wrong_kind", said: FILE_NOT_A_TOPIC };

    // A CLAIM goes through `attachToTopic`, never through `linkNodes` here: `note_claims` is
    // `claims.ts`'s table and §11.5's dual-write is its business, so a second writer of the
    // pair would be exactly the divergence `containsParity` exists to detect. A NOTE has no
    // membership row to mirror — `note_claims` cannot represent a topic containing a note —
    // so the edge is the whole act and `linkNodes` is the writer of it.
    const edgeId =
      item.kind === "m"
        ? (await attachToTopic(item.nodeId, container.id, tx, ctx.actor)).edgeId
        : (
            await linkNodes(
              { spaceId, from: container.id, to: item.nodeId, relation: "contains", createdBy: ctx.actor, originMessageId: ctx.messageId },
              tx,
            )
          ).id;

    return {
      status: "filed",
      edgeHandle: ctx.handles.mint({ kind: "g", spaceId, nodeId: edgeId }),
      // §4.7's sentence is "Filed «…» under «…»", and the FIRST slot is not filled: the
      // item's own words would be text this module composed out of a row it read, which is
      // the one thing its docstring says its returns never carry. The model addressed the
      // item by handle a line ago and knows what it filed; the topic's title comes back
      // because that is the half it did NOT choose by name.
      said: `Filed under «${container.title}».`,
    };
  });
}

/* ------------------------------------------------------------------------------------------
 * FORGETTING — `memory_forget` (§4.9)
 * ---------------------------------------------------------------------------------------- */

export type MemoryForgetStatus =
  | "forgotten"
  | "requires_owner_ui"
  | "revision_mismatch"
  | "not_found"
  | "wrong_kind"
  | "retired";

/**
 * §4.9's sentences.
 *
 * `requires_owner_ui` IS THE INTERESTING ONE, and it says where the thing is rather than
 * that the model may not have it: the person asked for a fact to be forgotten, and the only
 * useful answer is the one that gets it forgotten. "No approval gate" removed the APPROVAL of
 * writes; it did not hand retrieved documents deletion authority, and the two are unrelated
 * decisions.
 *
 * The `f`/`e`/`g` refusals exist because `knowledge_sources` and `vault_edges` carry no
 * `created_task_id`: A BOUND THAT CANNOT BE EXPRESSED MUST NOT BE IMPLIED. They are refused
 * rather than checked, and the sentences say who can.
 */
export const FORGET_SAID: Record<MemoryForgetStatus, string> = {
  forgotten: "Removed. It is off the user's memory page and out of future chats.",
  requires_owner_ui:
    "This saved item can only be removed by the owner, on the memory page in settings. Tell them where it is and what to look for.",
  revision_mismatch: "That item has moved on. Run memory_search and re-issue against what is there.",
  not_found: "There is nothing at that address. Run memory_search and use a handle it returned.",
  wrong_kind: "Fragments and links are not removable on their own.",
  retired: "This project's memory was deleted. Nothing to remove.",
};

/** The `f` arm, which is a different sentence because a document has a different answer: a
 *  person removes it, and there is a page where they do it. */
const FORGET_DOCUMENT = "A document is removed by its owner on the memory page.";

export type MemoryForgetResult =
  | { status: "forgotten"; said: string }
  | { status: "revision_mismatch"; revision: number; said: string }
  | { status: "requires_owner_ui" | "not_found" | "wrong_kind" | "retired"; said: string };

/**
 * `memory_forget` (§4.9): the agent may soft-delete ONLY a node whose `created_task_id`
 * equals THIS run's `taskId` — enough to undo its own malformed write in the same turn, and
 * nothing more.
 *
 * THE BOUND IS A COLUMN COMPARISON IN THE DB WRITE, not the handle map, and it is not this
 * function: `forgetClaim` takes `requireCreatedTaskId` and puts it in its own `WHERE`, and
 * `forgetNote` builds the equivalent `EXISTS` over the head version and hands it to
 * `deleteNode` as an extra clause on the node UPDATE. Reachability is not authority, and this
 * repo's history says a rule enforced at one entrance grows a second — so it is enforced
 * where the row is written and nowhere else.
 *
 * An approval/`ask` continuation is a SECOND task with its own `makeVaultMemoryTools` call
 * (§4.1, L8), so handles minted in the first half are void in the second AND this bound
 * cannot reach the first half's writes. Both are correct and both are stated so nobody
 * re-derives them as bugs.
 */
export async function memoryForget(a: {
  handle: string;
  expectedRevision: number;
  ctx: WriteCtx;
}): Promise<MemoryForgetResult> {
  const { ctx } = a;
  const allowedSpaceIds = ctx.projectSpaceId ? [ctx.userSpaceId, ctx.projectSpaceId] : [ctx.userSpaceId];
  const t = ctx.handles.resolve(a.handle);
  if (!t || !allowedSpaceIds.includes(t.spaceId)) return { status: "not_found", said: FORGET_SAID.not_found };
  // `m` and `n` ONLY (M9). `f`, `e` and `g` are REFUSED and never checked, because the tables
  // behind them carry no `created_task_id` and a bound that cannot be expressed must not be
  // implied. Two sentences, because a document has an owner surface and a fragment does not.
  if (t.kind === "f") return { status: "wrong_kind", said: FORGET_DOCUMENT };
  if (t.kind !== "m" && t.kind !== "n") return { status: "wrong_kind", said: FORGET_SAID.wrong_kind };
  const spaceId = t.spaceId;

  return db.transaction(async (tx): Promise<MemoryForgetResult> => {
    if (!(await spaceAcceptsWrites(spaceId, tx))) return { status: "retired", said: FORGET_SAID.retired };

    if (t.kind === "m") {
      // The pre-read is for the REPORT, never for the decision: the bound is in the statement
      // below, and this only lets the two failure modes be told apart. A `revision_mismatch`
      // the model can re-read beats a `requires_owner_ui` it cannot cross.
      const head = await findCurrentHead(t.nodeId, [spaceId], tx);
      if (!head) return { status: "not_found", said: FORGET_SAID.not_found };
      if (head.revision !== a.expectedRevision) {
        return { status: "revision_mismatch", revision: head.revision, said: FORGET_SAID.revision_mismatch };
      }
      const done = await forgetClaim(
        {
          claimId: t.nodeId,
          expectedRevision: a.expectedRevision,
          allowedSpaceIds: [spaceId],
          actor: ctx.actor,
          requireCreatedTaskId: ctx.taskId,
        },
        tx,
      );
      // Zero rows with a matching revision means the BOUND refused it — the row is older than
      // this task. `forgetClaim` deliberately does not say which of its conditions failed, and
      // it does not need to: the revision was just checked one statement up.
      return done.ok
        ? { status: "forgotten", said: FORGET_SAID.forgotten }
        : { status: "requires_owner_ui", said: FORGET_SAID.requires_owner_ui };
    }

    const done = await forgetNote(
      {
        noteId: t.nodeId,
        spaceId,
        expectedRevision: a.expectedRevision,
        createdTaskId: ctx.taskId,
        actor: ctx.actor,
      },
      tx,
    );
    if (done.ok) return { status: "forgotten", said: FORGET_SAID.forgotten };
    if (done.reason === "revision_mismatch") {
      return { status: "revision_mismatch", revision: done.revision as number, said: FORGET_SAID.revision_mismatch };
    }
    return done.reason === "not_found"
      ? { status: "not_found", said: FORGET_SAID.not_found }
      : { status: "requires_owner_ui", said: FORGET_SAID.requires_owner_ui };
  });
}
