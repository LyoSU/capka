import type { TurnTaint } from "@/lib/tasks/turn-taint";
import { db } from "@/lib/db";
import type { VaultBudget } from "./budget";
import {
  createClaim,
  findCurrentHead,
  findExactDuplicate,
  secretShaped,
  updateClaim,
  type Actor,
  type PromptAccess,
  type SourceClass,
} from "./claims";
import { classify, type Grounding } from "./grounding";
import type { HandleMap } from "./handles";
import { noteHead } from "./notes";
import { spaceAcceptsWrites, type Ex } from "./spaces";
import { resolveTopic } from "./topics";

/**
 * THE WRITE HALF OF THE MEMORY TOOLS — `memory_fact_write` today, the note/file/link
 * writers as slice 2 continues.
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

    let grounding: Grounding;
    if (a.grounding.kind === "retrieved") {
      const classes: SourceClass[] = [];
      const bad: string[] = [];
      for (const h of a.grounding.handles) {
        const cls = await classOfHandle(h, ctx, allowedSpaceIds, tx);
        if (cls) classes.push(cls);
        else bad.push(h);
      }
      if (bad.length) return badHandle(bad);
      grounding = { kind: "retrieved", classes };
    } else {
      grounding = a.grounding;
    }

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

    // `prompt_access` is READ BACK rather than computed: the column is generated, and a
    // second expression for it in a tool return is the drift `accessOf` is pinned against.
    // The head is the row this transaction just wrote.
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
