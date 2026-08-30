import { tool } from "ai";
import { z } from "zod";
import { proposeCandidate, spaceForScope, verifyDirectProvenance } from "./candidates";
import { findCurrentHead, forgetClaim, listHeadClaims, updateClaim, type ClaimHead } from "./claims";
import { getOrCreateSpace } from "./spaces";

/** How many memory lines one search hands back. Memory rides in the turn's own
 *  context, so this ceiling is not "how much is interesting" but "how much we can
 *  afford to spend". */
const SEARCH_LIMIT = 20;

/** One line for the model: `[id@revision]` is how it addresses a claim in
 *  update/forget afterwards, so search and the success reply print it identically.
 *  Only non-sensitive claims ever reach it — see the search filter. */
const line = (c: ClaimHead) => `[${c.id}@${c.revision}] ${c.statement}${c.slotKey ? ` (slot: ${c.slotKey})` : ""}`;

/** What search says about sensitive claims: that they exist, and nothing else.
 *
 *  Query-independent BY CONSTRUCTION, which is the whole point. Withholding a
 *  statement while still matching on it is not withholding — `memory_search("
 *  diagnosis")` returning a hit confirms the category the withholding exists to
 *  protect, and a slot key like `health/hiv-status` names it outright. So the query
 *  sees none of these claims, and this sentence is appended to every answer in a
 *  space that holds one, whatever was asked.
 *
 *  No address either, deliberately: an id would be useless. `memory_forget` requires
 *  the user to name the fact, and the fact's text is exactly what is withheld — so
 *  there is no operation the agent can perform on one of these claims, and offering a
 *  handle would only invite it to try. Telling the user the record exists is the one
 *  thing it CAN do, and a count is enough for that. */
const withheldNotice = (n: number) =>
  `${n} saved item${n === 1 ? " is" : "s are"} marked sensitive: not searchable, and the contents are not shown here. Tell the user such a record exists if it matters; only they can act on it.`;

/** The language of a lost CAS, shared by update and forget: say how the world looks
 *  NOW and what to re-send with. `current: null` deliberately does not separate "the
 *  chain was forgotten" from "that claim is not in your spaces" — decided in
 *  `claims.ts`, and a tool has no business making the difference observable.
 *
 *  It says "no longer there", not "forgotten": the head may equally have been
 *  superseded, or have been in a space this caller cannot see, and naming one cause
 *  out of three would be a guess printed as a fact. */
const showable = (c: ClaimHead) => !c.sensitive && c.reviewStatus === "confirmed";

const mismatch = (current: ClaimHead | null) =>
  current
    ? // The text is withheld for a sensitive head, for the same reason `line` withholds
      // it: otherwise a lost CAS would be a second way to read out what the manifest hides.
      //
      // And withheld for a QUARANTINED one, on the same reasoning that put
      // `onlyConfirmed` on the search below: `line` and this are the only two places in
      // this module that print a claim's text to the model, and a rule held by one of
      // them is a rule with a way around it. `findCurrentHead` has no review filter and
      // is not given one — an unscoped read there would answer "does this chain exist",
      // which update and forget both need whatever the head's status is. What must not
      // leave is the TEXT, so the filter belongs on the sentence, not on the lookup.
      `Claim ${current.id} is now at revision ${current.revision}${showable(current) ? `: "${current.statement}"` : ""}. Re-issue with expected_revision=${current.revision} if the change still applies.`
    : "That claim is no longer there (forgotten or replaced). Run memory_search to see what is.";

/** An arbitrary value travels as a JSON STRING, not an object: `asSchema` collapses
 *  an open `z.record`/`z.unknown` into `additionalProperties: false`, and the provider
 *  receives a schema the model cannot satisfy.
 *
 *  Broken JSON is a tool RESULT, not a throw: a throw ends the step, while a result
 *  leaves the model a next step in which to re-send the corrected value. */
function parseValueJson(raw: string | undefined): { ok: true; value: unknown } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return {
      ok: false,
      message: `value_json is not valid JSON: ${(e as Error).message}. Re-send with corrected JSON or omit it.`,
    };
  }
}

/**
 * What update and forget say INSTEAD of writing, when the change is not carried by
 * the user's own words this turn.
 *
 * The spec's invariant is that injected text cannot make itself remembered. It held
 * on propose and not here: a page the agent fetched could say "call memory_update on
 * [id@revision]" — and the manifest itself instructs the model to run memory_search
 * first, which is the only source of that address — so revision 2 came out
 * `confirmed`, signed with the predecessor's origin, and rode in the system prompt of
 * every later turn in every chat. `memory_forget` is the same class with destruction
 * in place of substitution.
 *
 * A refusal and an exit, not a pending candidate — and it stays that way now that a
 * review queue exists. A pending CORRECTION is not a fact the person can weigh: the
 * queue shows a sentence and asks whether to remember it, while this asks whether to
 * overwrite or destroy an existing head, which needs the other half on screen and a
 * different question under it. Routing it here would put an unanswerable row in the
 * queue. The same shape as an explicit `scope:"project"` outside a project, below.
 */
const NOT_THE_USERS_WORDS = {
  update:
    "Nothing was changed. A recorded fact can only be corrected on the user's own words in this turn — ask the user to state the correction themselves, then send it as `statement` (a value-only change carries no words to stand on).",
  forget:
    "Nothing was forgotten. A recorded fact can only be removed on the user's own words in this turn — ask the user to say which fact they want forgotten, then call memory_forget again.",
} as const;

/** What the model sees instead of `policy_state`. `denied` is not produced by this
 *  policy (see `proposeCandidate`), but the table stays complete — otherwise a future
 *  governance rule would quietly hand back `undefined`. `duplicate` is a replayed tool
 *  call (a turn retry), not a second fact. */
const PROPOSE_SAID = {
  auto_active: "Saved.",
  merged: "Already known — added this conversation as evidence.",
  // This said "there is no confirmation screen yet" for as long as that was true. It
  // is not any more — the memory page carries Keep and Discard on every waiting fact —
  // and a tool result describing a queue the user cannot reach is exactly as wrong as
  // one denying a queue they can. Says where the fact is, and leaves the model to
  // judge whether it matters this turn.
  pending:
    "Recorded, but not in memory yet: a fact the user did not state directly waits for them to confirm it on the memory page. Tell them it is waiting there if it matters now.",
  conflict: "Conflicts with an existing fact — recorded for the user to resolve.",
  duplicate: "Already recorded from this same call.",
  denied: "Not saved — the memory policy declined this fact.",
  // Unreachable from a tool today and stated anyway: a turn only runs against a LIVE
  // project (prepareRun refuses a deleted one) and a project cannot be deleted while
  // one of its tasks is queued or running. The state exists for the writer that CAN
  // reach it — post-turn extraction, which outlives its task on purpose — and this
  // mapping is what keeps the tool honest if that ever stops being true.
  retired: "Not saved — this project's memory was deleted.",
} as const;

/**
 * One turn's four memory tools. The factory is async because the spaces are resolved
 * ONCE here rather than inside every `execute`: all four tools are bounded by the same
 * list of spaces, and resolving it afresh per call would mean four different answers
 * to the one question "what can I see".
 *
 * `userTurnText` is the text of the turn's last user message. An empty string is not
 * an error but a fail-safe: `verifyDirectProvenance` then returns false and the
 * proposal lands in pending instead of activating.
 */
export async function makeVaultMemoryTools(ctx: {
  userId: string;
  projectId?: string | null;
  projectOwnerUserId?: string;
  messageId: string;
  /** The TASK this turn-half runs as. Required, never optional: it is the only thing
   *  that tells the two halves of an approval turn apart, and an optional parameter is
   *  how a later caller reopens a hole by omission rather than by decision. */
  taskId: string;
  userTurnText: string;
}) {
  // The caller knows the project space's owner (it already holds the project row).
  // Its absence is a bug in the caller, not licence to invent an owner or quietly fall
  // back to the user space: either would file the fact in the wrong place.
  if (ctx.projectId && !ctx.projectOwnerUserId) {
    throw new Error("makeVaultMemoryTools: projectId requires projectOwnerUserId");
  }
  const userSpaceId = await getOrCreateSpace({ type: "user", refId: ctx.userId });
  const projectSpaceId =
    ctx.projectId && ctx.projectOwnerUserId
      ? await getOrCreateSpace({ type: "project", refId: ctx.projectId, ownerUserId: ctx.projectOwnerUserId })
      : null;
  const allowedSpaceIds = projectSpaceId ? [userSpaceId, projectSpaceId] : [userSpaceId];
  const actor = { kind: "agent" } as const;

  /** Every claim id involved in a CAS loss this turn — BOTH the id the model
   *  addressed and the id it was sent back to. A supersede changes the id, so the
   *  model's retry never carries the id it lost on: keyed on the request alone, this
   *  set could not match by construction, every loss was experienced as the first,
   *  and the conflict the second-loss branch promises was unreachable rather than
   *  merely rare. Holding both sides of the hop tracks the chain instead of the row,
   *  and still catches the model that re-sends the same stale id.
   *
   *  Lives in the factory's closure, and the factory is called once per turn — so the
   *  state dies with the turn by construction, with nothing to clean up. Ids only: the
   *  space is needed exactly where the conflict is written, and the probe for it lives
   *  there.
   *
   *  ACCEPTED: under CONSTANT churn the second loss ends the edit the model wanted —
   *  what it leaves depends on what it found: a conflict for a human when the claim's
   *  space resolves, and nothing at all when the head has gone, that branch declining
   *  rather than guessing a space. Neither is progress on the edit, which is the
   *  accepted part; going round again is not progress either, and it costs the turn's
   *  whole tool budget. */
  const mismatched = new Set<string>();

  /** Which space a claim lives in. `ClaimHead` carries no `spaceId` (a claim's text
   *  goes only to callers who cleared the space filter), so the only way to ask is
   *  with a narrower scope. Called from the conflict branch alone: most CAS losses
   *  never see a second one, and there is nothing to buy by paying for the SELECT up
   *  front.
   *
   *  `null` means the head is in NEITHER space — forgotten or superseded between the
   *  CAS loss and this probe. Both spaces are asked explicitly, neither is a fallback:
   *  defaulting to the user space filed a PROJECT-specific conflict as global
   *  knowledge about the person, under a tool result claiming it had been recorded.
   *  Not writing is strictly better than guessing the scope. */
  const claimSpaceId = async (claimId: string): Promise<string | null> => {
    if (projectSpaceId && (await findCurrentHead(claimId, [projectSpaceId]))) return projectSpaceId;
    return (await findCurrentHead(claimId, [userSpaceId])) ? userSpaceId : null;
  };

  return {
    memory_search: tool({
      description:
        "Search saved memory (facts about the user and this project). Returns claims as [id@revision] lines — use those ids for memory_update/memory_forget.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Words to look for; Ukrainian or English"),
        scope: z.enum(["user", "project", "all"]).optional().describe("Default: all"),
      }),
      execute: async ({ query, scope }) => {
        // Outside a project, `scope: "project"` yields an empty list of spaces — more
        // honest than quietly substituting the user space: the model asked for
        // something else.
        const spaceIds =
          scope === "user"
            ? [userSpaceId]
            : scope === "project"
              ? projectSpaceId
                ? [projectSpaceId]
                : []
              : // The project space first: inside a project chat it is closer to the
                // matter at hand, and there is nothing to truly merge two ordered lists
                // by — `ClaimHead` does not carry `recorded_at`.
                (projectSpaceId ? [projectSpaceId, userSpaceId] : [userSpaceId]);
        const needle = query.toLowerCase();
        const buckets: ClaimHead[][] = [];
        let withheld = 0;
        for (const spaceId of spaceIds) {
          // `onlyConfirmed` because this is a READER that hands text to the model,
          // and the quarantine rule — an unverified claim never reaches a prompt — is
          // the manifest's and the memory page's rule too. It was held at those two
          // and walked past here, and `vault_claims.review_status` DEFAULTS to
          // `unverified`, so the first writer that omits the field (plan B's ingest,
          // plan D's review queue) would have gone straight into the model's context
          // with nothing red anywhere. The three INTERNAL callers pass `{}` on purpose
          // — `candidates.ts` dedups and `migrate-memory-docs.ts` attaches, and both
          // have to see every row or they duplicate the ones they cannot see.
          const heads = await listHeadClaims(spaceId, { onlyConfirmed: true });
          // Counted BEFORE the match and never matched against — see `withheldNotice`.
          withheld += heads.filter((c) => c.sensitive).length;
          // The equivalent of `ILIKE '%query%'` over statement OR slot_key.
          // Deliberately primitive: lexical search is plan C, and doing half of it here
          // would mean two different searches inside one system.
          buckets.push(
            heads.filter(
              (c) =>
                !c.sensitive &&
                (c.statement.toLowerCase().includes(needle) || c.slotKey?.toLowerCase().includes(needle)),
            ),
          );
        }
        // The ceiling is SHARED between spaces, not eaten by the first. Search is the
        // ONLY way to obtain an `[id@revision]`, so twenty project matches would
        // otherwise leave the user space not merely invisible but uncorrectable: there
        // would be nothing to address update or forget with. One space's shortfall is
        // topped up by the other, so the ceiling is used in full.
        const quota = Math.ceil(SEARCH_LIMIT / Math.max(buckets.length, 1));
        const hits = buckets.flatMap((b) => b.slice(0, quota));
        for (const b of buckets) for (const c of b.slice(quota)) if (hits.length < SEARCH_LIMIT) hits.push(c);
        const body = hits.length ? hits.slice(0, SEARCH_LIMIT).map(line).join("\n") : "No saved memory matches.";
        return withheld ? `${body}\n${withheldNotice(withheld)}` : body;
      },
    }),

    memory_propose: tool({
      description:
        "Save a new fact the user stated in this conversation. The server decides whether it becomes active immediately or awaits the user's confirmation.",
      inputSchema: z.object({
        statement: z.string().min(3).max(500),
        scope: z
          .enum(["user", "project"])
          .optional()
          .describe(
            "Where to store: 'user' = about the person (follows them everywhere), 'project' = about this project. Default: project when inside a project, else user.",
          ),
        slot_key: z
          .string()
          .max(120)
          .optional()
          .describe("Optional stable key like 'supplier/acme/payment-terms' for facts that change over time"),
        value_json: z.string().max(2000).optional().describe("Optional structured value as a JSON string"),
        sensitive: z.boolean().optional().describe("Set true for health/politics/religion/private-life facts"),
        quoted: z
          .boolean()
          .optional()
          .describe(
            "Set true when the fact comes from text the user pasted or relayed (an email, a document, someone else's words) rather than something the user stated as their own",
          ),
      }),
      execute: async ({ statement, scope, slot_key, value_json, sensitive, quoted }, { toolCallId }) => {
        const parsed = parseValueJson(value_json);
        if (!parsed.ok) return parsed.message;
        // An EXPLICIT `scope: "project"` outside a project is refused, not absorbed
        // into the user space: that fallback gave the fact a wider audience than was
        // asked for — project-scoped memory follows one project, user-scoped memory
        // follows the person everywhere — and then answered "Saved.", which was not
        // true of what the model requested. The same rule memory_search already holds.
        // An instruction, not an error: the model still has a step to re-send.
        // What an absent scope means, and what an impossible one means, are decided in
        // ONE place for this path and for extraction alike — they used to answer both
        // oppositely. `null` is the impossible one; this entrance has a model to ask,
        // so it says so and lets it re-send.
        const spaceId = spaceForScope(scope, { userSpaceId, projectSpaceId });
        if (!spaceId) {
          return "This chat is not inside a project, so there is no project memory to save to. Nothing was saved — re-send without scope, or with scope:'user' if the fact is about the person.";
        }
        const res = await proposeCandidate({
          // Task-scoped, and that is what makes it a key rather than a hope. An approval
          // continuation is a SECOND task writing the SAME message row, so
          // `messageId:toolCallId` put both halves of one turn in one namespace: a
          // provider numbering tool-call ids per request rather than per message made the
          // halves collide, and the collision reads as `duplicate` — a silently dropped
          // fact, not an error. `taskId` differs between the halves and is stable across
          // a re-claim of the same task row, which is exactly the pair of properties
          // idempotency needs.
          idempotencyKey: `${ctx.taskId}:${ctx.messageId}:${toolCallId}`,
          spaceId,
          originMessageId: ctx.messageId,
          statement,
          slotKey: slot_key,
          value: parsed.value,
          // The barrier against injection: "the user said this themselves" is not the
          // tool's word for it but a check against the text of their own turn. No match
          // means `derived`, and the policy sends the fact for confirmation instead of
          // activating it.
          //
          // `quoted` is the same distinction extraction draws, and it is here for the
          // same reason: a fact the user RELAYED is not a fact the user stated, and the
          // words of a pasted email are in the turn either way. The predicate drops
          // quoted spans on its own — this flag is what an honest model uses to say so
          // when the paste carries no quotation marks.
          provenance: {
            kind: !quoted && verifyDirectProvenance(statement, ctx.userTurnText) ? "user_direct" : "derived",
            messageId: ctx.messageId,
          },
          sensitive,
          // Without this the reply "added this conversation as evidence" would be
          // untrue: these are exactly the pieces `proposeCandidate` tops a head up with
          // on a merge.
          evidence: [{ messageId: ctx.messageId }],
        });
        return PROPOSE_SAID[res.state];
      },
    }),

    memory_update: tool({
      description:
        "Correct or refine an existing memory claim. Requires the claim id and revision from memory_search. At least one of statement/value_json must be provided.",
      inputSchema: z
        .object({
          claim_id: z.string(),
          expected_revision: z.number().int().min(1),
          statement: z.string().min(3).max(500).optional(),
          value_json: z.string().max(2000).optional(),
          quoted: z
            .boolean()
            .optional()
            .describe(
              "Set true when the correction comes from text the user pasted or relayed (an email, a document, someone else's words) rather than something the user stated as their own",
            ),
        })
        // Validated on the server but NOT carried into the JSON Schema — which is why
        // the same requirement is spelled out verbatim in `description`, or the model
        // would never learn of it.
        .refine((v) => v.statement !== undefined || v.value_json !== undefined, {
          message: "provide statement or value_json",
        }),
      execute: async ({ claim_id, expected_revision, statement, value_json, quoted }, { toolCallId }) => {
        const parsed = parseValueJson(value_json);
        if (!parsed.ok) return parsed.message;
        // The same barrier propose stands behind, in the same shape and for the same
        // reason — see NOT_THE_USERS_WORDS. `quoted` is here too: the rewrite entrance
        // was the weaker one against an unmarked paste while only propose could be
        // told the words were relayed. A value-only change has no text of its own, so
        // the predicate finds nothing to establish authorship with and refuses: the
        // fail-safe answer, and the model still has a step in which to re-send the
        // statement the user actually said.
        if (quoted || !verifyDirectProvenance(statement ?? "", ctx.userTurnText)) return NOT_THE_USERS_WORDS.update;

        const patch: { statement?: string; value?: unknown; sensitive?: true; origin?: Record<string, unknown> } = {
          // The successor carries its OWN provenance. Inheriting the predecessor's
          // signs the user's new words with somebody else's origin — the same defect
          // the confirm path had to fix. Past the guard above, this turn's provenance
          // is `user_direct` by construction.
          origin: { kind: "user_direct", messageId: ctx.messageId },
        };
        if (statement !== undefined) patch.statement = statement;
        if (value_json !== undefined) patch.value = parsed.value;

        const res = await updateClaim({
          claimId: claim_id,
          expectedRevision: expected_revision,
          patch,
          allowedSpaceIds,
          actor,
        });
        // A supersede creates a NEW row, so the claim's id changed: without it the
        // model's next update would go to a dead address.
        if (res.ok) return `Updated. The claim is now [${res.id}@${res.revision}].`;

        // There is no claim (the chain was ended OR it is not in our spaces) — and a
        // second loss does not change that. A conflict here would be an argument with
        // nothing: the human would be shown "resolve this" against a fact that does not
        // exist, and the model's text would enter the store under a nonexistent id.
        if (!res.current) return mismatch(null);
        // Either end of the hop having been seen means this chain has already been
        // handed back once this turn.
        const seenBefore = mismatched.has(claim_id) || mismatched.has(res.current.id);
        mismatched.add(claim_id).add(res.current.id);
        if (!seenBefore) return mismatch(res.current);
        // A second loss in a row on the same claim is no longer "re-read" but a
        // divergence a human resolves. There is nothing to record without new TEXT,
        // though: a candidate is a statement somebody will read, and putting the old
        // wording there would record a conflict with itself.
        if (statement === undefined) return mismatch(res.current);
        // The claim's space does not resolve — the head vanished between the CAS loss
        // and the probe. The same sentence as for `current: null`: there is no space
        // to write the conflict into, and inventing one would put the fact in the
        // wrong scope and then lie about it in the tool result.
        const conflictSpaceId = await claimSpaceId(claim_id);
        if (!conflictSpaceId) return mismatch(null);
        await proposeCandidate({
          idempotencyKey: `${ctx.taskId}:${ctx.messageId}:${toolCallId}:conflict`,
          spaceId: conflictSpaceId,
          originMessageId: ctx.messageId,
          statement,
          // Not `user_direct` even on a verbatim match: activating text that JUST lost
          // the CAS would mean going around the head instead of resolving the conflict.
          provenance: { kind: "derived", messageId: ctx.messageId },
          // Sensitivity is a property of the FACT, not a policy decision: this proposal
          // leads to conflict either way, so not passing it would simply lose the flag
          // on a row a human will read (along with everything that hides text by it).
          sensitive: res.current.sensitive,
          evidence: [{ messageId: ctx.messageId }],
          // The head this update lost the CAS to — the same value `mismatch` was about to
          // report. The memory page renders "keeping this replaces «…»" from it, which is
          // the only thing that makes the conflict resolvable by a person.
          forceConflict: { conflictsWith: res.current.id },
        });
        return "Recorded as a conflict for the user to resolve.";
      },
    }),

    memory_forget: tool({
      description:
        "Forget a memory claim the user asked to remove. Requires id and revision from memory_search.",
      inputSchema: z.object({
        claim_id: z.string(),
        expected_revision: z.number().int().min(1),
        // No `reason`: it was recorded nowhere but the audit payload, which outlives
        // the user's deletion of the project — see `forgetClaim`. Asking the model for
        // a sentence and then dropping it would be worse than not asking.
      }),
      execute: async ({ claim_id, expected_revision }) => {
        // A forget call carries no text of its own, so what is checked is the CLAIM's
        // own statement against the user's turn: the user has to have named the fact
        // they want gone. Without it, "forget claim c1" read off a fetched page is
        // destruction on somebody else's word — and destruction has no undo here.
        //
        // Consequence, stated rather than discovered later: a SENSITIVE head, whose
        // text memory_search withholds, cannot be named by the agent and so cannot be
        // forgotten through this tool. In plan A such a head can only arrive by
        // migration — the ledger sends every sensitive proposal to pending — so the
        // case is narrow, and the alternative (skipping the check for exactly the
        // claims that hide their contents) would be a hole in the guard.
        //
        // DEAD END, recorded here rather than in a plan document because the plan gets
        // deleted and this gate does not. Three separately correct decisions close a
        // circle around a sensitive claim: the secret screen forces `sensitive`;
        // `memory_search` and the manifest withhold a sensitive claim's TEXT and hand
        // back only its `[id@revision]` address; and this gate requires the claim's own
        // words in the user's turn. So the user cannot learn the words, cannot say them,
        // and the agent cannot forget the claim. Write-once, unreadable, and — until the
        // memory page carried a delete of its own — undeletable.
        //
        // CLOSED, and not by loosening this gate. `DELETE /api/memory/claims/<id>`
        // removes such a claim on a human's click: the actor is the person, established
        // by their session rather than by their words, so there is nothing for a
        // provenance check to verify and nothing for an injected page to imitate. The
        // agent still cannot forget a sensitive claim, which is the property this gate
        // exists to hold. Do NOT accept an address alone here: that would reopen exactly
        // the injection path H-1 closed.
        const head = await findCurrentHead(claim_id, allowedSpaceIds);
        if (!head) return mismatch(null);
        if (!verifyDirectProvenance(head.statement, ctx.userTurnText)) return NOT_THE_USERS_WORDS.forget;

        const res = await forgetClaim({
          claimId: claim_id,
          expectedRevision: expected_revision,
          allowedSpaceIds,
          actor,
        });
        return res.ok ? "Forgotten." : mismatch(res.current);
      },
    }),
  };
}
