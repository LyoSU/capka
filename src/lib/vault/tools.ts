import { tool } from "ai";
import { z } from "zod";
import type { TurnTaint } from "@/lib/tasks/turn-taint";
import { MEMORY_SEARCH_MAX_RESULTS, type VaultBudget } from "./budget";
import type { HandleMap } from "./handles";
import { proposeCandidate, spaceForScope } from "./candidates";
import { findCurrentHead, STATEMENT_MAX_CHARS, type ClaimHead, type SourceClass } from "./claims";
import { countWithheld, listMemoryToolRows, modelTextOf, type MemoryToolText } from "./model-view";
import { verifyDirectProvenance } from "./quote-match";
import { getOrCreateSpace } from "./spaces";
import { TOPIC_TITLE_MAX_CHARS } from "./topics";
import { factWrite, type WriteCtx } from "./write-tools";

/**
 * WHAT ONE SEARCH HANDS BACK, and why it is JSON with handles in it rather than the
 * `[id@revision]` lines this tool printed until slice 2.
 *
 * ```json
 * { "results": [{ "handle": "m1", "kind": "claim", "title": null, "excerpt": "…",
 *                 "revision": 3, "sourceClass": "user_direct", "scope": "user",
 *                 "topic": null }],
 *   "omitted": 17, "withheld": 3, "note": "…" }
 * ```
 *
 * `handle` IS THE ONLY ADDRESS. A persistent claim or note id is never shown to the model
 * and never accepted from it: a handle is minted per RUN, so one that arrives from a
 * previous turn, from a fetched page, or from the model's own invention resolves to
 * nothing, and the write tools reject the whole mutation rather than proceed with a hole.
 * An id in a tool result is an id an injected page can quote back.
 *
 * THERE IS NO `resultSet` FIELD, and its absence is a decision rather than an omission —
 * recorded here because a test asserting it could not fail (this tool has never had one)
 * and a control that cannot fail is decoration. The draft shape carried a `resultSet`
 * token for a later call to page through; nothing consumed it, and `omitted` already says
 * the one thing the model needs to know about what it did not get.
 *
 * `title` and `topic` are `null` on a claim. `title` because a claim has no title — it is
 * one sentence. `topic` because the mint's claim arm has no containing-topic lookup: the
 * label a note carries is the note's OWN label when it is a topic container, and naming a
 * claim's parent topic needs the `contains` edge read, not a wider projection.
 *
 * The whole thing goes through `ctx.budget.emit`, which is what makes the per-turn ceiling
 * reachable at all — every byte here is re-sent on every later step of the same
 * tool-calling loop, so the cost is per step and not per call.
 *
 * THE TEXT FIELDS ARE BRANDED, and that is what the deleted `line()` formatter was for:
 * `MemoryToolText` is mintable only inside `model-view.ts`, so a future reader that pulls a
 * row off `listHeadClaims` and builds one of these does not compile, and a `ManifestText`
 * cannot be substituted either — the three channel symbols are mutually unassignable.
 * `JSON.stringify` is indifferent to a brand; `tsc` is not.
 */
type SearchResult = {
  handle: string;
  kind: "claim" | "note";
  title: MemoryToolText | null;
  excerpt: MemoryToolText;
  revision: number;
  sourceClass: SourceClass;
  scope: "user" | "project";
  topic: MemoryToolText | null;
};

/** "No lexical match is not evidence of absence" ships on EVERY response, not only empty
 *  ones: an agent that reads it only on zero results has already concluded absence on a
 *  thin result set, which is the same wrong conclusion arrived at from the other direction.
 *
 *  The spec's sentence ends "…and knowledge_search for documents". That half is NOT shipped
 *  here: `knowledge_search` is slice 3, and pointing the model at a tool its turn does not
 *  hold teaches it to report a search it could not run. It joins this line with the tool. */
const ABSENCE_NOTE = "No lexical match is not evidence of absence - try other wordings.";

/** How the world looks NOW, when the claim the model addressed is not what it thought.
 *  `current: null` deliberately does not separate "the chain was forgotten" from "that
 *  claim is not in your spaces" — decided in `claims.ts`, and a tool has no business
 *  making the difference observable.
 *
 *  It says "no longer there", not "forgotten": the head may equally have been
 *  superseded, or have been in a space this caller cannot see, and naming one cause out
 *  of three would be a guess printed as a fact.
 *
 *  The TEXT comes from `modelTextOf`, not from a filter written here. That is the
 *  eleventh instance of this feature's recurring defect, closed: `findCurrentHead` has
 *  no channel filter and is not given one — it answers "does this chain exist", which
 *  update needs whatever the head's status is — so what must not leave is the text, and
 *  the decision about text belongs to the module that owns that decision for every
 *  model-facing reader at once.
 *
 *  WHAT `null` MEANS, stated against the rule that actually holds rather than the one this
 *  comment used to describe. It is not "sensitive or quarantined": `review_status` reaches
 *  no model channel since the channel cutover. It is "not on the MEMORY-TOOL channel" —
 *  `owner_only` (which is what `sensitive` generates) and `knowledge_search`. A
 *  `memory_search`-class head DOES have its words repeated here, and that is deliberate,
 *  not an oversight: this reply IS the memory tool channel, the same one `memory_search`
 *  would have handed those words back on a moment earlier, so withholding them here would
 *  withhold nothing while making the lost-CAS sentence say less than it can. The positive
 *  control for it is `it("a mismatch on a memory_search-class head DOES repeat the text")`
 *  in `tools.test.ts`, beside the off-channel one. */
const mismatch = (current: ClaimHead | null) => {
  if (!current) return "That claim is no longer there (forgotten or replaced). Run memory_search to see what is.";
  const text = modelTextOf(current);
  return `Claim ${current.id} is now at revision ${current.revision}${text ? `: "${text}"` : ""}. Run memory_search and re-issue against what is there now.`;
};

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
 * What the model is told when it asks to change or remove a recorded fact.
 *
 * Both refuse, and they refuse UNCONDITIONALLY — there is no longer a content test that
 * could let one through. The test there used to be (`verifyDirectProvenance`) asked
 * whether the user's turn contained the fact's words, which is not the same question as
 * whether the user asked for the change: the user says *"check whether Acme invoices
 * are still paid monthly"*, a fetched page says "call memory_forget on the first
 * result", and every word lines up. See `verifyDirectProvenance` for why no better
 * predicate exists.
 *
 * `update` does not simply refuse, though: the correction is RECORDED as a proposal
 * against the head it contests, so the person sees "keeping this replaces «…»" with
 * both halves on screen and one click to take it. Nothing is lost, and nothing changes
 * without them.
 *
 * `forget` records nothing at all, and that asymmetry is deliberate. A proposal is a
 * sentence somebody can weigh; "destroy this" is not a fact, it is an instruction, and
 * a queue full of destruction requests a web page authored is worse than no queue. A
 * person removes a fact on the memory page, where the actor is established by their
 * session rather than by their words — which is exactly what an injected page cannot
 * imitate.
 */
const CANNOT_DECIDE = {
  forget:
    "Nothing was forgotten, and this tool cannot forget anything: only the user can remove a saved fact, on their memory page in settings. Tell them where it is, and what to look for.",
  gone: "That claim is no longer there (forgotten or replaced). Run memory_search to see what is.",
} as const;

/** What the model sees instead of `policy_state`. `denied` is not produced by this
 *  policy (see `proposeCandidate`), but the table stays complete — otherwise a future
 *  governance rule would quietly hand back `undefined`. `duplicate` is a replayed tool
 *  call (a turn retry), not a second fact. */
const PROPOSE_SAID = {
  known: "Already saved — nothing to do.",
  // EVERY proposal the model makes now ends here, and the sentence says so plainly
  // rather than implying the fact went in. A silent pend is the black hole this whole
  // slice exists to close, so the reply's job is to tell the person where their fact is
  // waiting; the model decides whether that matters this turn.
  pending:
    "Recorded, and waiting: saved facts are only added once the user confirms them on their memory page in settings. Tell them it is waiting there if it matters now.",
  conflict:
    "Recorded as a correction for the user to approve on their memory page in settings — the existing fact is unchanged until they do.",
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
 *
 * THREE PER-TURN OBJECTS ARRIVE FROM `prepareRun`, and all three have the factory's own
 * lifetime for the factory's own reason: it is called exactly once per turn, and an object
 * created twice would give the turn two answers to one question. The handle map would mint
 * `m1` twice for different rows; the budget would grant the ceiling twice; the taint would
 * lose half a turn's marks. An approval continuation is a SECOND task and therefore gets
 * fresh handles and a fresh budget — correct, and stated in §4.1 — while the taint is
 * SEEDED from the persisted column rather than re-created empty, which is the whole of
 * NEW-1.
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
  /** The run-local address space the model sees instead of persistent ids. */
  handles: HandleMap;
  /** What the vault may still spend of this turn's context. */
  budget: VaultBudget;
  /** Whether this turn has already read something it did not author. */
  taint: TurnTaint;
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

  /** Which space a claim lives in. `ClaimHead` carries no `spaceId` (a claim's text goes
   *  only to callers who cleared the space filter), so the only way to ask is with a
   *  narrower scope.
   *
   *  `null` means the head is in NEITHER space — forgotten or superseded between the
   *  lookup and this probe. Both spaces are asked explicitly, neither is a fallback:
   *  defaulting to the user space filed a PROJECT-specific correction as global
   *  knowledge about the person, under a tool result claiming it had been recorded.
   *  Not writing is strictly better than guessing the scope. */
  const claimSpaceId = async (claimId: string): Promise<string | null> => {
    if (projectSpaceId && (await findCurrentHead(claimId, [projectSpaceId]))) return projectSpaceId;
    return (await findCurrentHead(claimId, [userSpaceId])) ? userSpaceId : null;
  };

  /** The write tools' half of this turn's context, built ONCE beside the spaces for the
   *  same reason they are: all of it has the turn's lifetime, and a second copy would give
   *  the turn a second answer to "what can I see" and "what have I spent". */
  const writeCtx: WriteCtx = {
    userSpaceId,
    projectSpaceId,
    handles: ctx.handles,
    taint: ctx.taint,
    budget: ctx.budget,
    taskId: ctx.taskId,
    messageId: ctx.messageId,
    userTurnText: ctx.userTurnText,
    // The AGENT wrote it, whatever class the words earned. `source_class` records what the
    // words are worth; the actor records who moved, and no grounding makes the model into
    // the person — which is exactly the distinction `ownerAuthored()` exists to keep.
    actor: { kind: "agent" },
  };

  return {
    memory_search: tool({
      description:
        "Search saved memory (facts about the user and this project). Send several wordings of the same question in one call — Ukrainian and English, or a synonym — rather than searching repeatedly. Each result carries a short handle like m1 or n2, which is how you address it in a later call; saved items marked sensitive are never searched and never shown, and 'withheld' counts them, so if one matters tell the user such a record exists — only they can act on it.",
      inputSchema: z.object({
        queries: z
          .array(z.string().min(1))
          .min(1)
          .max(5)
          .describe("1-5 wordings of the same question; Ukrainian or English"),
        scope: z.enum(["user", "project", "all"]).optional().describe("Default: all"),
        kinds: z
          .array(z.enum(["claim", "note"]))
          .min(1)
          .max(2)
          .optional()
          .describe("Default: both. 'claim' = a saved fact, 'note' = a written note or topic"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MEMORY_SEARCH_MAX_RESULTS)
          .optional()
          .describe(`Default: ${MEMORY_SEARCH_MAX_RESULTS}`),
      }),
      execute: async ({ queries, scope, kinds, limit }) => {
        // Outside a project, `scope: "project"` yields an empty list of spaces — more
        // honest than quietly substituting the user space: the model asked for something
        // else.
        const spaceIds =
          scope === "user"
            ? [userSpaceId]
            : scope === "project"
              ? (projectSpaceId ? [projectSpaceId] : [])
              : (projectSpaceId ? [projectSpaceId, userSpaceId] : [userSpaceId]);
        // ONE call across both spaces, which is what the fusion makes possible: the old
        // per-space loop had to invent a quota because it was merging two ordered lists
        // with nothing to merge them BY. A fused score is comparable across spaces, so the
        // ceiling is spent on relevance instead of on an arithmetic split.
        const { rows: hits, omitted } = await listMemoryToolRows(spaceIds, {
          queries,
          limit: limit ?? MEMORY_SEARCH_MAX_RESULTS,
          kinds,
        });
        // An aggregate over what the mint excludes, computed independently of the query
        // and never matched against. Withholding a statement while still MATCHING on it is
        // not withholding — a hit for `memory_search("diagnosis")` confirms the category the
        // withholding exists to protect — so the count is the whole of what may be said, and
        // it carries no handle: `memory_forget` requires the user to name the fact, the
        // fact's text is exactly what is withheld, and an address would only invite a try.
        // Counting it off the returned rows would count the wrong set, since those are
        // precisely the rows that are NOT withheld.
        let withheld = 0;
        for (const spaceId of spaceIds) withheld += await countWithheld(spaceId);

        const results = hits.map(
          (r): SearchResult => ({
            // The handle is minted from `(space, node)` because that pair is what the write
            // tools resolve back to. `m` for a fact, `n` for a note — the letter is the whole
            // of what a handle says about its target.
            handle: ctx.handles.mint({ kind: r.kind === "claim" ? "m" : "n", spaceId: r.spaceId, nodeId: r.id }),
            kind: r.kind,
            title: r.kind === "note" ? r.title : null,
            excerpt: r.excerpt,
            revision: r.revision,
            sourceClass: r.sourceClass,
            // Folded from the space id, which never leaves this function: the model is told
            // WHICH memory a row came from, not the row's storage key. A row can only be in
            // a space this call asked about, so "not the project space" is the user space.
            scope: r.spaceId === projectSpaceId ? "project" : "user",
            topic: r.kind === "note" ? r.topic : null,
          }),
        );
        // `omitted` says how many eligible matches did not fit. A silent truncation reads to
        // the model as "that is all there is", which is the same wrong conclusion the note
        // exists to prevent, arrived at from the other direction.
        return ctx.budget.emit(JSON.stringify({ results, omitted, withheld, note: ABSENCE_NOTE }));
      },
    }),

    /**
     * THE WRITE, and it writes — there is no confirmation step and no `pending`. What it
     * stores appears on the person's memory page in this same release with one-click undo,
     * which is what makes an additive, visible, undoable creation a different act from a
     * mutation and the reason the maintainer's no-gate decision is implementable at all.
     *
     * `op` and `grounding` are REQUIRED DISCRIMINATED UNIONS, not optional flags beside a
     * string enum: a producer that forgets to say where a fact came from must fail to
     * compile, and a fourth grounding kind must be added to a union every switch re-exhausts.
     * The wire names are the spec's snake_case; the mapping to `factWrite`'s TS names
     * happens in one place, right below, so neither side has to speak the other's.
     */
    memory_fact_write: tool({
      description:
        "Save a fact to memory, or replace one you found with memory_search. It is saved immediately — the user sees it on their memory page and can undo it there, so do not ask them to confirm. Say where the fact came from in 'grounding': quote the user's own words when they stated it, list the handles you read it from when it came from saved memory or a document, or say it is your own inference. A fact about the person goes to scope 'user' and follows them into every chat; a fact about this project goes to scope 'project'. The reply tells you how it was recorded — read it, because a correction that cannot be traced to the user is stored beside the old fact instead of replacing it.",
      inputSchema: z.object({
        op: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("create"),
            scope: z
              .enum(["user", "project"])
              .describe("'user' = about the person, follows them everywhere; 'project' = about this project"),
          }),
          z.object({
            kind: z.literal("replace"),
            target_handle: z.string().describe("The m-handle of the fact being replaced, from memory_search"),
            expected_revision: z.number().int().min(1),
          }),
        ]),
        statement: z.string().min(3).max(STATEMENT_MAX_CHARS),
        grounding: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("current_user_quote"),
            quote: z
              .string()
              .describe("The user's own words from THIS turn, verbatim, that the statement is made of"),
          }),
          z.object({
            kind: z.literal("retrieved"),
            handles: z.array(z.string()).min(1).max(8).describe("The handles this fact was read from"),
          }),
          z.object({ kind: z.literal("agent_inference") }),
        ]),
        topic: z
          .string()
          .max(TOPIC_TITLE_MAX_CHARS)
          .optional()
          .describe("The subject in the user's words, or an n-handle of an existing topic. Default: General"),
        sensitive: z.boolean().optional().describe("Set true for health/politics/religion/private-life facts"),
        value_json: z.string().max(2000).optional().describe("Optional structured value as a JSON string"),
      }),
      execute: async ({ op, statement, grounding, topic, sensitive, value_json }) =>
        // Through the SAME per-turn ceiling every vault answer goes through: a write's
        // reply is re-sent on every later step of the tool-calling loop exactly like a
        // search's, so it is spent from one allowance and not from a second.
        writeCtx.budget.emit(
          JSON.stringify(
            await factWrite({
              op:
                op.kind === "create"
                  ? { kind: "create", scope: op.scope }
                  : { kind: "replace", targetHandle: op.target_handle, expectedRevision: op.expected_revision },
              statement,
              grounding,
              topic,
              sensitive,
              valueJson: value_json,
              ctx: writeCtx,
            }),
          ),
        ),
    }),

    memory_propose: tool({
      description:
        "Record a new fact the user stated in this conversation. It is saved for the user to confirm on their memory page — it does not enter memory until they do.",
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
          // RECORDED, and authorizing nothing. It used to decide whether this fact went
          // straight into memory; it cannot, because the user's words are present both
          // when they asked for this and when a fetched page did — see
          // `verifyDirectProvenance`. What survives is worth keeping: a note, on the row
          // the person will read, saying the words were their own.
          //
          // `quoted` is the same distinction extraction draws: a fact the user RELAYED
          // is not a fact the user stated, and the words of a pasted email are in the
          // turn either way. It is model-supplied and was never a boundary; it is
          // recorded on the same footing.
          provenance: {
            kind: !quoted && verifyDirectProvenance(statement, ctx.userTurnText) ? "user_direct" : "derived",
            messageId: ctx.messageId,
          },
          sensitive,
          // The conversation this came out of, carried on the candidate and applied to
          // the claim by whoever confirms it — which is what lets the memory page say
          // where a fact came from.
          evidence: [{ messageId: ctx.messageId }],
        });
        return PROPOSE_SAID[res.state];
      },
    }),

    // AN INTERIM WINDOW, deliberate and short: `memory_search` stopped printing persistent
    // ids in this commit, so nothing in a turn now hands the model a `claim_id` to pass
    // here. That is the plan's ordering, not an oversight — the write tools that take a
    // HANDLE (`memory_fact_write`) land next, and they retire this tool and `memory_forget`
    // with them. The description says "from memory_search" no longer, because that would be
    // an instruction the model cannot follow; what it says instead is true in the window and
    // after it.
    memory_update: tool({
      description:
        "Record a correction to an existing memory fact, addressed by its claim id and revision. The correction is saved for the user to approve on their memory page; the existing fact is unchanged until they do.",
      inputSchema: z.object({
        claim_id: z.string(),
        expected_revision: z.number().int().min(1),
        statement: z.string().min(3).max(500),
      }),
      execute: async ({ claim_id, expected_revision, statement }, { toolCallId }) => {
        // NO WRITE HAPPENS HERE, and the shape of this tool changed to say so. It used
        // to supersede the head outright on the strength of `verifyDirectProvenance`,
        // and a fetched page could spend that authority: the manifest itself tells the
        // model to run memory_search first, which is the only source of the address the
        // page needs it to use. So revision 2 came out confirmed, signed with the
        // predecessor's origin, and rode in every later system prompt.
        //
        // `value_json` went with the write. A value-only change carries no sentence, and
        // a proposal with no words is a row a person cannot decide on; the tool takes a
        // `statement` now, always, because that is what the memory page has to show.
        const head = await findCurrentHead(claim_id, allowedSpaceIds);
        if (!head) return CANNOT_DECIDE.gone;
        // The revision is checked, though nothing is being written: a correction
        // proposed against a version the model has not seen would put a stale "replaces
        // «…»" in front of the person. Cheap, and it keeps the address meaningful.
        if (head.revision !== expected_revision) return mismatch(head);

        const spaceId = await claimSpaceId(claim_id);
        // The head resolved a moment ago and its space does not: it was forgotten in
        // between. Nothing to contest, and inventing a space would file the correction
        // in the wrong scope and then claim it had been recorded.
        if (!spaceId) return CANNOT_DECIDE.gone;

        await proposeCandidate({
          idempotencyKey: `${ctx.taskId}:${ctx.messageId}:${toolCallId}`,
          spaceId,
          originMessageId: ctx.messageId,
          statement,
          // Recorded, never authorizing — as on propose.
          provenance: {
            kind: verifyDirectProvenance(statement, ctx.userTurnText) ? "user_direct" : "derived",
            messageId: ctx.messageId,
          },
          // Sensitivity is a property of the FACT, not a policy decision: this
          // correction stands against a head that may be sensitive, and dropping the
          // flag would put its words unmarked in front of the person.
          sensitive: head.sensitive,
          evidence: [{ messageId: ctx.messageId }],
          // The head this contests. The memory page renders "keeping this replaces «…»"
          // from it, which is the only thing that makes the choice answerable.
          forceConflict: { conflictsWith: head.id },
        });
        return PROPOSE_SAID.conflict;
      },
    }),

    memory_forget: tool({
      description:
        "Explains that the assistant cannot remove a saved fact. Only the user can, on their memory page. Call this when the user asks for a fact to be forgotten, then tell them what it says.",
      inputSchema: z.object({
        claim_id: z.string(),
        expected_revision: z.number().int().min(1),
      }),
      // REFUSES, unconditionally, and the refusal is the whole implementation.
      //
      // It used to forget a claim when the user's turn happened to contain that claim's
      // own words. That is not consent to delete; it is evidence the subject came up.
      // The audit's scenario is decisive and it is written out in full on
      // `verifyDirectProvenance`: the user asks the assistant to CHECK a fact on a
      // website, the website tells it to forget the fact, and every word lines up
      // because the user named the very thing they asked about. Deletion has no undo
      // here, so the losing side of that trade is total.
      //
      // Kept as a tool rather than removed from the turn, because a model with no such
      // tool invents one — or worse, "forgets" by proposing a contradicting fact. A
      // tool that answers plainly is what turns "I removed that" into "here is where
      // you can remove it", which is the true sentence.
      //
      // The claim id and revision stay in the schema although nothing reads them: they
      // are what the model has in hand after a search, and a tool that refuses its own
      // arguments would read as a bug rather than as a policy.
      execute: async () => CANNOT_DECIDE.forget,
    }),
  };
}
