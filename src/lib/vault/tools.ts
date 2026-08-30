import { tool } from "ai";
import { z } from "zod";
import { looksLikeSecret, proposeCandidate, verifyDirectProvenance } from "./candidates";
import { findCurrentHead, forgetClaim, listHeadClaims, updateClaim, type ClaimHead } from "./claims";
import { getOrCreateSpace } from "./spaces";

/** How many memory lines one search hands back. Memory rides in the turn's own
 *  context, so this ceiling is not "how much is interesting" but "how much we can
 *  afford to spend". */
const SEARCH_LIMIT = 20;

/** One line for the model: `[id@revision]` is how it addresses a claim in
 *  update/forget afterwards, so search and the success reply print it identically.
 *
 *  A sensitive claim travels as its ADDRESS only. The caller of these tools is the
 *  agent, not the human: printing the statement here would put it in the model's
 *  context — precisely where the manifest already refuses to put it — and from there
 *  into the reply. The id and slot still travel, so the agent can tell the user such
 *  a record exists and can forget it by id. */
const line = (c: ClaimHead) =>
  `[${c.id}@${c.revision}] ${c.sensitive ? "(saved as sensitive — contents withheld)" : c.statement}${
    c.slotKey ? ` (slot: ${c.slotKey})` : ""
  }`;

/** The language of a lost CAS, shared by update and forget: say how the world looks
 *  NOW and what to re-send with. `current: null` deliberately does not separate "the
 *  chain was forgotten" from "that claim is not in your spaces" — decided in
 *  `claims.ts`, and a tool has no business making the difference observable.
 *
 *  It says "no longer there", not "forgotten": the head may equally have been
 *  superseded, or have been in a space this caller cannot see, and naming one cause
 *  out of three would be a guess printed as a fact. */
const mismatch = (current: ClaimHead | null) =>
  current
    ? // The text is withheld for a sensitive head, for the same reason `line` withholds
      // it: otherwise a lost CAS would be a second way to read out what the manifest hides.
      `Claim ${current.id} is now at revision ${current.revision}${current.sensitive ? "" : `: "${current.statement}"`}. Re-issue with expected_revision=${current.revision} if the change still applies.`
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

/** What the model sees instead of `policy_state`. `denied` is not produced by this
 *  policy (see `proposeCandidate`), but the table stays complete — otherwise a future
 *  governance rule would quietly hand back `undefined`. `duplicate` is a replayed tool
 *  call (a turn retry), not a second fact. */
const PROPOSE_SAID = {
  auto_active: "Saved.",
  merged: "Already known — added this conversation as evidence.",
  pending: "Saved as awaiting the user's confirmation.",
  conflict: "Conflicts with an existing fact — recorded for the user to resolve.",
  duplicate: "Already recorded from this same call.",
  denied: "Not saved — the memory policy declined this fact.",
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

  /** Claims that have already lost the CAS in THIS turn. Lives in the factory's
   *  closure, and the factory is called once per turn — so the state dies with the
   *  turn by construction, with nothing to clean up. Holds ids only: the space is
   *  needed exactly where the conflict is written, and the probe for it lives there.
   *
   *  ACCEPTED (GPT audit #11): under CONSTANT churn on one claim the model can lose
   *  the CAS, be told the new revision, lose again, and file a conflict — making no
   *  progress on the edit it wanted. Exotic (it needs a competitor superseding the
   *  same claim between two tool calls of one turn), and the cost is bounded: the
   *  agent burns its tool budget for the turn and the database blocks on nothing.
   *  What the second loss leaves depends on what it found: a conflict for a human when
   *  the claim's space resolves, and nothing at all when the head has gone — that
   *  branch declines rather than guessing a space. Neither outcome is progress on the
   *  edit the model wanted, which is the accepted part. */
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
        for (const spaceId of spaceIds) {
          // The equivalent of `ILIKE '%query%'` over statement OR slot_key.
          // Deliberately primitive: lexical search is plan C, and doing half of it here
          // would mean two different searches inside one system.
          buckets.push(
            (await listHeadClaims(spaceId)).filter(
              (c) => c.statement.toLowerCase().includes(needle) || c.slotKey?.toLowerCase().includes(needle),
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
        return hits.length ? hits.slice(0, SEARCH_LIMIT).map(line).join("\n") : "No saved memory matches.";
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
      }),
      execute: async ({ statement, scope, slot_key, value_json, sensitive }, { toolCallId }) => {
        const parsed = parseValueJson(value_json);
        if (!parsed.ok) return parsed.message;
        // An EXPLICIT `scope: "project"` outside a project is refused, not absorbed
        // into the user space: that fallback gave the fact a wider audience than was
        // asked for — project-scoped memory follows one project, user-scoped memory
        // follows the person everywhere — and then answered "Saved.", which was not
        // true of what the model requested. The same rule memory_search already holds.
        // An instruction, not an error: the model still has a step to re-send.
        if (scope === "project" && !projectSpaceId) {
          return "This chat is not inside a project, so there is no project memory to save to. Nothing was saved — re-send without scope, or with scope:'user' if the fact is about the person.";
        }
        // After the guard, "wants project" implies there IS one; the condition is
        // kept for the type, not for a case that can still happen.
        const wantsProject = (scope ?? (projectSpaceId ? "project" : "user")) === "project";
        const spaceId = wantsProject && projectSpaceId ? projectSpaceId : userSpaceId;
        const res = await proposeCandidate({
          idempotencyKey: `${ctx.messageId}:${toolCallId}`,
          spaceId,
          originMessageId: ctx.messageId,
          statement,
          slotKey: slot_key,
          value: parsed.value,
          // The barrier against injection: "the user said this themselves" is not the
          // tool's word for it but a check against the text of their own turn. No match
          // means `derived`, and the policy sends the fact for confirmation instead of
          // activating it.
          provenance: {
            kind: verifyDirectProvenance(statement, ctx.userTurnText) ? "user_direct" : "derived",
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
        })
        // Validated on the server but NOT carried into the JSON Schema — which is why
        // the same requirement is spelled out verbatim in `description`, or the model
        // would never learn of it.
        .refine((v) => v.statement !== undefined || v.value_json !== undefined, {
          message: "provide statement or value_json",
        }),
      execute: async ({ claim_id, expected_revision, statement, value_json }, { toolCallId }) => {
        const parsed = parseValueJson(value_json);
        if (!parsed.ok) return parsed.message;
        const patch: { statement?: string; value?: unknown; sensitive?: true } = {};
        if (statement !== undefined) patch.statement = statement;
        if (value_json !== undefined) patch.value = parsed.value;
        // The successor is screened too. `updateClaim` INHERITS `sensitive` from the
        // predecessor, so without this an ordinary claim rewritten into one that
        // carries a credential would stay non-sensitive — and the manifest would put
        // it in every later prompt, going around the screen the ledger applies on the
        // way in. Only ever raised: sensitivity is never cleared by a rewrite.
        if (statement !== undefined && looksLikeSecret(statement)) patch.sensitive = true;

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
        if (!mismatched.has(claim_id)) {
          mismatched.add(claim_id);
          return mismatch(res.current);
        }
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
          idempotencyKey: `${ctx.messageId}:${toolCallId}:conflict`,
          spaceId: conflictSpaceId,
          originMessageId: ctx.messageId,
          statement,
          // Not `user_direct` even on a verbatim match: activating text that JUST lost
          // the CAS would mean going around the head instead of resolving the conflict.
          provenance: { kind: "derived", messageId: ctx.messageId },
          // Sensitivity is a property of the FACT, not a policy decision: `forceState`
          // leads to conflict either way, so not passing it would simply lose the flag
          // on a row a human will read (along with everything that hides text by it).
          sensitive: res.current.sensitive,
          evidence: [{ messageId: ctx.messageId }],
          forceState: "conflict",
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
        reason: z.string().max(300).optional(),
      }),
      execute: async ({ claim_id, expected_revision, reason }) => {
        const res = await forgetClaim({
          claimId: claim_id,
          expectedRevision: expected_revision,
          allowedSpaceIds,
          actor,
          reason,
        });
        return res.ok ? "Forgotten." : mismatch(res.current);
      },
    }),
  };
}
