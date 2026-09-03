import { tool } from "ai";
import { z } from "zod";
import type { TurnTaint } from "@/lib/tasks/turn-taint";
import { MEMORY_OPEN_MAX_BYTES, MEMORY_SEARCH_MAX_RESULTS, type VaultBudget } from "./budget";
import type { HandleMap } from "./handles";
import { STATEMENT_MAX_CHARS, type SourceClass } from "./claims";
import { countWithheld, listMemoryToolRows, type MemoryToolText } from "./model-view";
import { NOTE_BLOCKS_MAX, NOTE_BLOCK_MAX_CHARS, NOTE_TITLE_MAX_CHARS } from "./notes";
import { TOPIC_SECTIONS } from "./memory-sections";
import { memoryOpen } from "./read-tools";
import { getOrCreateSpace } from "./spaces";
import { TOPIC_TITLE_MAX_CHARS } from "./topics";
import { factWrite, memoryFile, memoryForget, memoryLink, noteEdit, noteWrite, type WriteCtx } from "./write-tools";

/** The blocks a whole-file write hands over. Shared by `create` and `update`, which take
 *  the identical body — one shape, so the two arms cannot drift apart. */
const NOTE_CONTENT = z
  .array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("markdown"), text: z.string().min(1).max(NOTE_BLOCK_MAX_CHARS) }),
      z.object({
        kind: z.literal("node_link"),
        target_handle: z.string().describe("An m- or n-handle from memory_search"),
      }),
    ]),
  )
  .min(1)
  .max(NOTE_BLOCKS_MAX)
  .describe("The note's blocks, in order");

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
 * one sentence. `topic` is a COST DECISION about this projection, and no longer a statement
 * that the lookup does not exist: `openClaimForModel` performs exactly it (`note_claims`
 * joined to the container's label), so `memory_open` on a handle from these results does
 * name the topic. What search will not do is run that join per ROW — this list is capped in
 * the tens and re-sent on every later step of the same tool-calling loop, so a field the
 * model can ask for one row at a time is not worth a join and a wider payload for all of
 * them. §4.2's example shows a non-null topic here; filling it is a slice-3 change, not a
 * missing read.
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

/*
 * WHAT WENT WITH THE TWO RETIRED TOOLS, recorded because each was a decision and a reader
 * who finds them missing should not have to reconstruct why.
 *
 *   `mismatch` — the lost-CAS reply. It composed a sentence around `modelTextOf`, and
 *     `memory_update` was its only caller; the new writers report a REVISION and never the
 *     text, so the one channel decision it made now lives only in the mint.
 *   `parseValueJson` — `memory_propose`'s. `factWrite` has its own, because a broken value is
 *     a RESULT there rather than a string returned from a tool body.
 *   `CANNOT_DECIDE` / `PROPOSE_SAID` — the sentences of a memory that could only propose.
 *     Every status the write tools return is a sentence in `SAID`, `NOTE_SAID`, `FILE_SAID`,
 *     `OPEN_SAID` or `FORGET_SAID`, beside the writer that produces it.
 *   `claimSpaceId` — asked "which of my two spaces holds this claim id", which only a tool
 *     taking a persistent id ever needed. A handle carries its space.
 */

/**
 * ONE TURN'S MEMORY TOOLS — search, open, and the five writers. The factory is async because
 * the spaces are resolved ONCE here rather than inside every `execute`: every tool is bounded
 * by the same list of spaces, and resolving it afresh per call would mean as many answers as
 * there are tools to the one question "what can I see".
 *
 * `memory_propose` and `memory_update` are GONE (§4.10). They were retired in the same
 * release that shipped the write tools rather than running beside them, because the parallel
 * period rounds 0-4 described was never implementable: §11.8 stops `proposeCandidate` being
 * called from a tool in slice 2, §2.12 turns `memory_candidates` into a read-only archive from
 * that moment, and an archive that has stopped being written cannot coexist with two live
 * producers writing into it. `memory_update` was also unaddressable the moment this
 * `memory_search` shipped: it needed the `[id@revision]` address only the old search emitted.
 *
 * `userTurnText` is the text of the turn's last user message. An empty string is not an error
 * but a fail-safe: rule 1's clause 1 then fails and the write lands as the agent's own
 * conclusion instead of as something the person stated.
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

  const tools = {
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
        "Save a fact to memory, or replace one you found with memory_search. It is saved immediately — the user sees it on their memory page and can undo it there, so do not ask them to confirm. Say where the fact came from in 'grounding': quote the user's own words when they stated it, list the handles you read it from when it came from saved memory or a document, or say it is your own inference. A fact about the person goes to scope 'user' and follows them into every chat; a fact about this project goes to scope 'project'. The reply tells you how it was recorded — read it, because a correction that cannot be traced to the user is stored beside the old fact instead of replacing it. The exact shapes, so the first call is accepted: op {\"kind\":\"create\",\"scope\":\"user\"} or {\"kind\":\"replace\",\"target_handle\":\"m1\",\"expected_revision\":1}; grounding {\"kind\":\"current_user_quote\",\"quote\":\"…\"}, {\"kind\":\"retrieved\",\"handles\":[\"m2\"]} or {\"kind\":\"agent_inference\"} — 'kind' is required on both.",
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

    /**
     * THE NOTE WRITER. Same nine steps, same order, one longer piece of text — and one thing
     * the model cannot express: a persistent link out of a title it typed.
     *
     * `content` is a list of BLOCKS, and the `node_link` block carrying a HANDLE is the only
     * way a link can be made. A `[[Title]]` in a markdown block is stored as literal text
     * forever (§7): the model has no id vocabulary, so it cannot mint an edge, and the server
     * will not guess which note a title meant.
     */
    memory_note_write: tool({
      description:
        "Write a short topic file to memory, or update one you found with memory_search. This is the writer to reach for whenever you learn something a person would want to READ later — how they work, what a project needs, who somebody is — because the user sees these files on their memory page as a list they can open, and a single fact is a line they cannot edit. Keep ONE file per subject and keep it short: search first, and if a file about this subject already exists, UPDATE it rather than writing a second one about the same thing. Say which heading it belongs under in 'section'. It is saved immediately and the user can undo it on their memory page, so do not ask them to confirm. To link to another saved note or fact, put a 'node_link' block in the content with its handle; typing [[a title]] in the text does NOT make a link, it stays as plain text. Say where the content came from in 'grounding', the same way memory_fact_write does. Updating a file replaces its current version and needs the revision you were given; a file carrying more authority than this write, or any update in a turn that read a document or a web page, is refused — write a new one instead. To change a sentence use str_replace with the text exactly as memory_open showed it; to add a paragraph use insert; rename changes only the title; use update only when most of the file changes. Replace the SMALLEST span that is unique in the file — one word or one clause, not the whole sentence — so that the words you add are the user's own. Keep the files up to date, coherent and organized: rename or delete a file that is no longer relevant, and do not create a new file unless necessary. The exact shapes, so the first call is accepted: op {\"kind\":\"create\",\"scope\":\"user\",\"title\":\"Invoicing\",\"content\":[{\"kind\":\"markdown\",\"text\":\"Invoices go out on the 1st.\"}]}; op {\"kind\":\"str_replace\",\"note_handle\":\"n1\",\"expected_revision\":1,\"old_str\":\"the 1st\",\"new_str\":\"the 5th\"}; grounding {\"kind\":\"current_user_quote\",\"quote\":\"invoices go out on the 5th\"} — 'kind' is required on op, on grounding and on every content block.",
      /**
       * THE OP IS WHERE THE SHAPE LIVES, and `title`/`content` moved INSIDE it.
       *
       * Five arms now write a note: two that hand over a whole body (`create`, `update`) and
       * three that change part of one in place. `content` is meaningless on a `str_replace`
       * and `old_str` is meaningless on a `create`, so at the top level every one of them
       * would have to be optional — and an optional field is a field the model may send
       * anywhere. Inside the arms the discriminant decides, and the provider refuses a
       * mismatched call before a database is touched. `.strict()` is what makes that a
       * refusal rather than a silent strip.
       */
      inputSchema: z.object({
        op: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("create"),
              scope: z
                .enum(["user", "project"])
                .describe("'user' = about the person, follows them everywhere; 'project' = about this project"),
              title: z
                .string()
                .min(1)
                .max(NOTE_TITLE_MAX_CHARS)
                .describe("The subject, in the user's own words. One line, no newlines"),
              content: NOTE_CONTENT,
            })
            .strict(),
          z
            .object({
              kind: z.literal("update"),
              note_handle: z.string().describe("The n-handle of the note being rewritten, from memory_search"),
              expected_revision: z.number().int().min(1),
              title: z
                .string()
                .min(1)
                .max(NOTE_TITLE_MAX_CHARS)
                .describe("The subject, in the user's own words. One line, no newlines"),
              content: NOTE_CONTENT,
            })
            .strict(),
          z
            .object({
              kind: z.literal("str_replace"),
              note_handle: z.string().describe("The n-handle of the file being edited, from memory_search"),
              expected_revision: z.number().int().min(1),
              old_str: z
                .string()
                .min(1)
                .max(2 * NOTE_BLOCK_MAX_CHARS)
                .describe(
                  "The text to replace, EXACTLY as memory_open showed it (without the line numbers). It must appear once in the file",
                ),
              new_str: z
                .string()
                .max(2 * NOTE_BLOCK_MAX_CHARS)
                .optional()
                .describe("What to put there instead. Leave it out to delete old_str"),
            })
            .strict(),
          z
            .object({
              kind: z.literal("insert"),
              note_handle: z.string().describe("The n-handle of the file being edited, from memory_search"),
              expected_revision: z.number().int().min(1),
              insert_line: z
                .number()
                .int()
                .min(0)
                .describe("The line number from memory_open to insert AFTER. 0 puts the text at the top of the file"),
              insert_text: z
                .string()
                .min(1)
                .max(2 * NOTE_BLOCK_MAX_CHARS)
                .describe("The lines to add"),
            })
            .strict(),
          z
            .object({
              kind: z.literal("rename"),
              note_handle: z.string().describe("The n-handle of the file being renamed, from memory_search"),
              expected_revision: z.number().int().min(1),
              title: z
                .string()
                .min(1)
                .max(NOTE_TITLE_MAX_CHARS)
                .describe("The new subject line. The file's text is left alone"),
            })
            .strict(),
        ]),
        /**
         * THE SHELF, and the reason it is a `z.enum` rather than a free string: a fifth
         * value is refused by the provider before a database is touched, so the CHECK on
         * `vault_notes.section` is the backstop and not the diagnosis.
         *
         * OPTIONAL, and the default is stated in the description rather than applied here:
         * §4.6's write is `create` OR `update`, and an update that omits this must leave the
         * file where the person filed it — a `.default("topic")` would make every text edit
         * quietly move it back. `noteWrite` passes `undefined` through for exactly that.
         */
        section: z
          // FROM THE TUPLE, not a fourth copy of the four values — `memory-sections.ts`
          // owns them and says why the schema's copy is the one that stays literal.
          .enum(TOPIC_SECTIONS)
          .optional()
          .describe(
            "Which heading this belongs under on the user's memory page: 'you' = what the person is like, 'topic' = a subject, 'area' = a part of their life or work, 'person' = somebody they deal with. Default: 'topic'. On an update or an edit, leave it out to keep the heading it already has",
          ),
        grounding: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("current_user_quote"),
            quote: z.string().describe("The user's own words from THIS turn, verbatim, that the note is made of"),
          }),
          z.object({
            kind: z.literal("retrieved"),
            handles: z.array(z.string()).min(1).max(8).describe("The handles this note was written from"),
          }),
          z.object({ kind: z.literal("agent_inference") }),
        ]),
        topic: z
          .string()
          .max(TOPIC_TITLE_MAX_CHARS)
          .optional()
          .describe(
            "The subject in the user's words, or an n-handle of an existing topic. On a create, leave it out to file under General; on an update, leave it out to keep the current filing. Not accepted on an edit",
          ),
      })
        // STRICT OUT HERE AS WELL AS INSIDE EACH ARM. The arm's own strictness says nothing
        // about the level above it, so a `content` sent BESIDE a `str_replace` rather than
        // inside it was stripped in silence — and a model that put the field in the wrong
        // place was then told its edit succeeded, carrying a body it believes it sent.
        .strict()
        // `topic` sits OUTSIDE the union because it means one thing on both whole-file arms,
        // so the arms' strictness cannot refuse it on an edit — and an edit re-files nothing,
        // so a `topic` sent with one was dropped in silence while the model believed it had
        // both edited and moved the file (Codex L3). Refused at the schema, like `content`.
        .superRefine((v, c) => {
          if (v.topic !== undefined && v.op.kind !== "create" && v.op.kind !== "update") {
            c.addIssue({ code: "custom", path: ["topic"], message: "topic is accepted on create and update only; an edit does not re-file" });
          }
        }),
      execute: async ({ op, grounding, topic, section }) =>
        writeCtx.budget.emit(
          JSON.stringify(
            // The wire shape is snake_case and the writers' are not, mapped in ONE place —
            // right here — so neither side has to speak the other's. `topic` reaches only
            // the two whole-file arms: an edit does not re-file, so passing it through would
            // let a text change move the file to a different shelf.
            op.kind === "create" || op.kind === "update"
              ? await noteWrite({
                  op:
                    op.kind === "create"
                      ? { kind: "create", scope: op.scope }
                      : { kind: "update", noteHandle: op.note_handle, expectedRevision: op.expected_revision },
                  title: op.title,
                  section,
                  content: op.content.map((b) =>
                    b.kind === "markdown"
                      ? { kind: "markdown" as const, text: b.text }
                      : { kind: "node_link" as const, targetHandle: b.target_handle },
                  ),
                  grounding,
                  topic,
                  ctx: writeCtx,
                })
              : await noteEdit({
                  op:
                    op.kind === "str_replace"
                      ? {
                          kind: "str_replace",
                          noteHandle: op.note_handle,
                          expectedRevision: op.expected_revision,
                          oldStr: op.old_str,
                          // OMITTED MEANS EMPTY, which is a deletion — the reference tool's
                          // own contract, and the reason the field is optional rather than
                          // requiring the model to send `""`.
                          newStr: op.new_str ?? "",
                        }
                      : op.kind === "insert"
                        ? {
                            kind: "insert",
                            noteHandle: op.note_handle,
                            expectedRevision: op.expected_revision,
                            insertLine: op.insert_line,
                            insertText: op.insert_text,
                          }
                        : {
                            kind: "rename",
                            noteHandle: op.note_handle,
                            expectedRevision: op.expected_revision,
                            title: op.title,
                          },
                  section,
                  grounding,
                  ctx: writeCtx,
                }),
          ),
        ),
    }),

    /**
     * ONE ITEM, IN FULL, by the handle a search returned — the read `memory_search`'s one-line
     * excerpts exist to make cheap. A note comes back a page at a time, and the page is
     * measured in the same UTF-8 bytes the turn's ceiling is spent in.
     */
    memory_open: tool({
      description:
        "Read one saved item in full, by a handle memory_search returned. Use it when an excerpt is not enough — the whole of a note, or what a fact is filed under and whether anything contradicts it. A long note comes back in pages: if the reply carries a cursor, call again with it to read on. A document handle returns only its details, never its contents.",
      inputSchema: z.object({
        handle: z.string().describe("A handle from memory_search, like m1 or n2"),
        cursor: z.string().optional().describe("Continue a long note: pass the cursor from the previous reply"),
        max_bytes: z
          .number()
          .int()
          .min(500)
          .max(MEMORY_OPEN_MAX_BYTES)
          .optional()
          .describe(`How much of a note to read at once, in bytes. Default: ${MEMORY_OPEN_MAX_BYTES}`),
      }),
      execute: async ({ handle, cursor, max_bytes }) =>
        // Through the SAME per-turn ceiling, which is what makes paging honest: a model that
        // pages through a note pays for every page out of one allowance.
        writeCtx.budget.emit(
          JSON.stringify(await memoryOpen({ handle, cursor, maxBytes: max_bytes, ctx: writeCtx })),
        ),
    }),

    /** FILING, which is the one write that stores no text: a `contains` edge from a topic to
     *  a fact or a note. `topic` on the two write tools names a topic for something being
     *  written; this attaches something that already exists. */
    memory_file: tool({
      description:
        "File a saved fact or note under a topic, so the user finds it grouped with the rest of that subject. Both handles come from memory_search, they have to be in the same memory (personal or this project), and you need the revision you were given for the item. A document is not filed under a topic — link it to a note with memory_link instead.",
      inputSchema: z.object({
        item_handle: z.string().describe("The m-handle of a fact or the n-handle of a note"),
        topic_handle: z.string().describe("The n-handle of a topic, from memory_search"),
        expected_item_revision: z.number().int().min(1),
      }),
      execute: async ({ item_handle, topic_handle, expected_item_revision }) =>
        writeCtx.budget.emit(
          JSON.stringify(
            await memoryFile({
              itemHandle: item_handle,
              topicHandle: topic_handle,
              expectedItemRevision: expected_item_revision,
              ctx: writeCtx,
            }),
          ),
        ),
    }),

    /** ONE link, added to a note that already exists — the edge and the block together, or
     *  neither (§4.8). `memory_note_write` is how a note gets its links at write time; this
     *  is how one more is added later without re-sending the whole body. */
    memory_link: tool({
      description:
        "Link a saved note to another saved note or fact, so the connection survives a rename. The note gains a link block mentioning the target and needs the revision you were given. Use this when the note already exists; when you are writing it, put node_link blocks in memory_note_write instead.",
      inputSchema: z.object({
        from_note_handle: z.string().describe("The n-handle of the note that will mention the target"),
        target_handle: z.string().describe("The m- or n-handle being linked to"),
        expected_note_revision: z.number().int().min(1),
      }),
      execute: async ({ from_note_handle, target_handle, expected_note_revision }) =>
        writeCtx.budget.emit(
          JSON.stringify(
            await memoryLink({
              fromNoteHandle: from_note_handle,
              targetHandle: target_handle,
              expectedNoteRevision: expected_note_revision,
              ctx: writeCtx,
            }),
          ),
        ),
    }),

    /**
     * FORGETTING, and since §4.9 it can actually forget — but only a node THIS task wrote.
     *
     * That is enough for the agent to undo its own malformed write inside the turn that made
     * it, and nothing more. Anything older is the owner's, on their page, where the actor is
     * established by their session rather than by their words — which is exactly what an
     * injected page cannot imitate. The settled attack is written out in full on
     * `verifyDirectProvenance`: the user asks the assistant to CHECK a fact on a website, the
     * website tells it to forget the fact, and every word lines up because the user named the
     * very thing they asked about. "No approval gate" removed the APPROVAL of writes; it did
     * not hand retrieved documents deletion authority, and the two are unrelated decisions.
     *
     * The bound is a column comparison in the DB write, not the handle map — see
     * `memoryForget`, `forgetClaim` and `forgetNote`.
     */
    memory_forget: tool({
      description:
        "Undo a memory write you made in THIS turn — a fact or a note you just saved with the wrong wording, in the wrong scope, or by mistake. Pass the handle and revision you were given. Anything saved earlier can only be removed by the user on their memory page; the reply says so, and then your job is to tell them where it is and what to look for.",
      inputSchema: z.object({
        handle: z.string().describe("The m- or n-handle of the item to remove"),
        expected_revision: z.number().int().min(1),
      }),
      execute: async ({ handle, expected_revision }) =>
        writeCtx.budget.emit(
          JSON.stringify(await memoryForget({ handle, expectedRevision: expected_revision, ctx: writeCtx })),
        ),
    }),
  };
  return capkaAuthored(tools);
}

/**
 * THE MEMORY TOOLS' OUTPUT IS CAPKA'S OWN, AND THE RUNNER HAS TO BE TOLD SO.
 *
 * `untrustedOutputOf` in `turn-taint.ts` reads `untrustedOutput` off the registered tool
 * object and treats an UNSET declaration as untrusted — the fail-closed default a new tool
 * gets until somebody states otherwise. Until this function existed nobody had stated it
 * for these seven, so every turn that called `memory_search` or `memory_open` was marked as
 * having read outside content, the mark rode `messages.untrusted_ingress` into every later
 * turn of the chat, and `noteWrite`/`noteEdit`'s taint conditions then refused every edit of
 * an existing file. The manifest tells the model to search first; so in practice no file
 * could ever be edited. Found in a live chat, not by a test: the acceptance suites seeded the
 * taint by hand and none asked whether a memory-only turn stays clean (ARM 0 does now).
 *
 * WHY `false` IS RIGHT BY CONSTRUCTION rather than by trust in the author: everything these
 * tools hand back as text goes through the memory-tool CHANNEL of `model-view.ts`
 * (`prompt_access in ('manifest','memory_search')`), and an `untrusted_derived` row lives on
 * the evidence channel — `memory_open` answers `off_channel` for it and never renders it. The
 * one arm that reads outside the channel, `memory_open` on a document handle, marks the
 * taint itself. Status sentences and edit snippets are Capka's own composition over rows the
 * same channel admitted.
 *
 * `withEffectLedger` spreads the tool object when it wraps `execute`, so the property
 * survives into the set the SDK receives, and the runner reads the PRE-wrap set anyway.
 */
function capkaAuthored<T extends Record<string, object>>(tools: T): { [K in keyof T]: T[K] & { untrustedOutput: false } } {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [name, { ...t, untrustedOutput: false as const }]),
  ) as { [K in keyof T]: T[K] & { untrustedOutput: false } };
}
