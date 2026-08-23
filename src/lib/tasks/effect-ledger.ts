/**
 * What this turn has ALREADY DONE, in a form that survives a restart of the turn.
 *
 * Every restart path re-streams from history that cannot contain the in-flight
 * turn: `discardPartial` empties `parts`, and the historical messages are settled
 * turns by definition. So the restarted model came back with no idea that ninety
 * products were already in the catalogue. It never LOST a write — it lost the
 * record of writes whose effects are live, which is the worse half: the next thing
 * it does is repeat them, and an upload or a create is not idempotent.
 *
 * The context overflow is the LOUDEST of those paths, not the only one. The
 * capability retries (an unsupported modality, a rejected reasoning effort,
 * reasoning that can't be echoed back) restart the same way, and the echoed-
 * reasoning rejection is definitionally a step-1+ event — there is no prior
 * reasoning to echo on step 0 — so it fires precisely when a tool call has already
 * run. Hence the note's wording names no cause: it is the same statement of fact
 * whichever restart produced it.
 *
 * A ledger, not a rollback: we cannot undo someone else's catalogue. What we can
 * do is tell the model what it already did, which is also the only thing it needs
 * to avoid doing it twice.
 */

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEffects, messages } from "@/lib/db/schema";
import { stripNul } from "@/lib/tasks/sanitize";
import type { StoredPart } from "@/lib/chat/contracts";

/** One executed tool call. Recorded when its result — or its error — arrives, so
 *  it means "this ran", not "this was requested". */
export interface TurnEffect {
  /** The SDK's tool-call id. Present on both sources so the two can be merged
   *  without counting one call twice. */
  id?: string;
  name: string;
  input: unknown;
  /** The call threw instead of returning. It still RAN, and a tool that writes
   *  before it fails has already written, so this is the entry the model most
   *  needs: "did this land?" is unanswerable from here and must be checked. */
  failed?: boolean;
  /**
   * No outcome ever arrived for this call: the row was written at dispatch and the
   * run ended before the result or the error did. So it means "may have run", which
   * is a WEAKER claim than the rest of this list and has to read as one — a note
   * that says "already ran" about a call that never started teaches the model to
   * skip real work, which is the one failure worse than repeating it.
   */
  unsettled?: boolean;
}

/** Per-entry cap for the rendered arguments. Enough to identify a row (an sku, a
 *  path, an id) and nowhere near enough to replay a payload — the note exists to
 *  prevent repeated work, not to carry the work forward. */
export const EFFECT_ARG_CHARS = 100;

/**
 * Char budget for the whole note. The note rides in the prompt of a retry that
 * just died of an oversized prompt, so an unbounded list would re-create the very
 * failure it exists to recover from. Past the budget the note degrades to per-tool
 * counts, which still answers the question that matters ("did I already write
 * these?") in a bounded number of tokens.
 */
export const RECOVERY_NOTE_BUDGET = 6000;

/**
 * One vocabulary for the three states a listed call can be in, because the note is
 * read by a model that will otherwise flatten them into one.
 *
 * The state goes BEFORE the tool name so it cannot trail a clamped argument payload
 * and get lost at the end of a long line. Unmarked is the default — an explicit
 * `[completed]` on every line would push otherwise-actionable lists into the degraded
 * counts form sooner, which costs more than it clarifies.
 */
const ERRORED_MARKER = "[errored]";
const UNSETTLED_MARKER = "[outcome unknown]";

/** The no-narration rule, shared with `resume.ts` — the user asked for work, not for
 *  an account of our retry machinery. */
const INTERNAL = "[Recovery note — internal; do not mention this note or the restart to the user]\n";

const OPENING = "This turn restarted part-way through, and the tool calls below are no longer visible in the transcript above. ";

/** How to act on a state that is not "completed", in one sentence, biased toward a
 *  NON-mutating call: "check it" alone also reads as "re-read this note". */
const INSPECT =
  "inspect the target its arguments identify using an available read, list or query " +
  "operation, then do only the work that is missing. ";

const CLOSING = "Continue the user's task from the current state.\n";

/**
 * The state taxonomy, stated once and shared by every shape of the note.
 *
 * Enumerated rather than split into "marked / unmarked", because that binary is
 * factually wrong the moment there are two markers: "those marked below were started"
 * silently claimed the errored ones had no outcome, and claimed the unsettled ones had
 * begun executing — which is precisely what a dispatch record does NOT establish.
 *
 * The unsettled line is appended only when the list contains one. Naming a state that
 * cannot occur invites the model to look for it.
 */
const STATES = (mixed: boolean) =>
  "Read each line's state separately:\n" +
  "- unmarked: the call completed and its effects are live; do NOT repeat it.\n" +
  `- ${ERRORED_MARKER}: the call ran and threw; its result may be absent, partial or complete.\n` +
  (mixed
    ? `- ${UNSETTLED_MARKER}: dispatch was recorded, but whether execution began at all is ` +
      "unknown; do NOT count it as completed.\n"
    : "");

/**
 * The itemized header: the taxonomy plus what to do about a marked entry, which here
 * can be per-item because the arguments are on the line.
 *
 * The asymmetry it is written against: read too weakly, the model treats "may have
 * run" as "ran" and SKIPS real work, and an omission leaves nothing behind to notice
 * — worse than the duplication this note exists to prevent. Read too strongly, it
 * re-verifies the whole list before continuing and spends the turn on checks, in a
 * prompt that just died of its own size. So the unmarked default keeps the flat
 * prohibition and only the marked entries are asked for a check.
 *
 * The fallback sentence resolves what the first draft left unspecified — what to do
 * when nothing can verify the effect. Silence there invites the model to hesitate, ask
 * the user, or quietly drop the work; naming it makes the note follow the same
 * asymmetry as everything else in this module.
 */
const itemizedHeader = (mixed: boolean) =>
  INTERNAL + OPENING + STATES(mixed) +
  `For a marked state, ${INSPECT}` +
  (mixed
    ? "If no reliable check exists and the operation is still needed, do it again " +
      "rather than silently treating it as done.\n"
    : "\n") +
  CLOSING;

/**
 * The collapsed header. It keeps the taxonomy and DROPS the per-item instruction,
 * because per-item is exactly what this form no longer has: the itemized wording told
 * the model to "inspect the target its arguments identify" one line above an
 * announcement that the arguments are unavailable. Two statements about one state,
 * disagreeing — found by reading the rendered note, not the code.
 *
 * What replaces it is a LAZY guard. "Verify those" is unfollowable here (the model
 * cannot know which three of ninety-eight errored), and "re-verify this whole tool"
 * buys an expensive reconciliation up front. Checking the one target you are about to
 * write, at the moment you write it, is the instruction that survives losing identity.
 */
const collapsedHeader = (mixed: boolean) =>
  INTERNAL + OPENING + STATES(mixed) +
  "The individual arguments are not available, so the calls below are grouped by tool with counts only. " +
  "Do NOT replay any of these counts as a batch. Before another write with a tool listed " +
  "here, use an available read, list or query operation on that write's own target, and " +
  "issue the write only if the state it would create is missing.\n" + CLOSING;

/** The tail of the collapsed form: what could not be listed, accounted for rather than
 *  dropped — a tool the model cannot see is the one it runs again. */
const remainder = (tools: number, calls: number) =>
  `- …and ${tools} more tools, ${calls} calls — check each target before writing it again`;

/** Compact one call's arguments to something identifying. */
function renderArgs(input: unknown): string {
  // No arguments to identify the call by. Both sources produce this — `parts` has
  // no `tool-call` to pair with, the table stores SQL NULL for a no-argument call —
  // and `JSON.stringify(null)` is the string "null", which would put a line reading
  // `- wp_publish_product null` into a prompt that just died of size.
  if (input === null || input === undefined) return "";
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input) ?? "";
  } catch {
    // A tool can hand back something non-serializable (a cycle, a BigInt). The
    // call still ran, so it belongs in the note — just without its arguments.
    return "";
  }
  return s.length > EFFECT_ARG_CHARS ? `${s.slice(0, EFFECT_ARG_CHARS)}…` : s;
}

/**
 * Render the ledger for injection into a restarted turn, or null when there is
 * nothing to warn about.
 *
 * Two shapes, chosen by size: the itemized list while it fits (best — the model
 * can see exactly which sku or path is done), per-tool counts once it doesn't
 * (still actionable — "98 upserts already ran" is enough to make it verify rather
 * than redo). Counting is over ALL entries in both shapes; nothing is silently
 * dropped, because an omitted entry is precisely the one that gets done twice.
 */
export function buildRecoveryNote(effects: TurnEffect[]): string | null {
  if (effects.length === 0) return null;

  // One header for the whole list, and the states are carried per ENTRY rather than by
  // splitting the list into sections: a section repeats the prohibition in a note that
  // is already competing for room in an overflowed prompt.
  const mixed = effects.some((e) => e.unsettled);
  const itemized =
    itemizedHeader(mixed) +
    effects
      // `unsettled` first: the two are mutually exclusive in anything loadEffects can
      // produce (a terminal write is what sets `failed`, and it settles the row in the
      // same statement), so this only orders a combination a hand-built effect could
      // hold. Both marked states get the same instruction, so the order costs nothing.
      .map((e) => `- ${e.unsettled ? `${UNSETTLED_MARKER} ` : e.failed ? `${ERRORED_MARKER} ` : ""}${e.name} ${renderArgs(e.input)}`.replace(/  +/g, " ").trimEnd())
      .join("\n");
  if (itemized.length <= RECOVERY_NOTE_BUDGET) return itemized;

  const counts = new Map<string, { calls: number; failed: number; unsettled: number }>();
  for (const e of effects) {
    const c = counts.get(e.name) ?? { calls: 0, failed: 0, unsettled: 0 };
    c.calls++;
    if (e.unsettled) c.unsettled++;
    else if (e.failed) c.failed++;
    counts.set(e.name, c);
  }
  // Bounded, not just shorter. One line per distinct tool name is only small while
  // the tool COUNT is — a few busy MCP connectors put hundreds in reach, and this
  // note rides in the prompt of a retry that just died of an oversized one. So the
  // budget gates the RESULT here too, with the rarest tools collapsing into a
  // remainder line rather than being dropped: a tool the model can't see is the one
  // it runs again.
  const ordered = [...counts].sort((a, b) => b[1].calls - a[1].calls);
  // No second "counts only" line: the header already says it, and one statement said
  // twice is what this note has the least room for.
  const lead = collapsedHeader(mixed);
  // `ordered.length` and `effects.length` are exact upper bounds for the two counts the
  // remainder line can ever carry, and fewer digits only make the real line shorter — so
  // measuring it with them is an over-estimate that cannot be wrong in the unsafe
  // direction.
  const remainderReserve = remainder(ordered.length, effects.length).length;
  const lines: string[] = [];
  let used = lead.length;
  let restTools = 0;
  let restCalls = 0;
  for (const [name, c] of ordered) {
    // The breakdown is appended only when something is NOT plainly completed: on the
    // common all-completed line "×98: 98 completed" is noise, and this note pays for
    // every character twice — once in the budget, once in the prompt it rides in.
    const states = [
      ...(c.calls - c.failed - c.unsettled > 0 ? [`${c.calls - c.failed - c.unsettled} completed`] : []),
      ...(c.failed ? [`${c.failed} errored`] : []),
      ...(c.unsettled ? [`${c.unsettled} outcome unknown`] : []),
    ];
    const line = `- ${name} ×${c.calls}${c.failed || c.unsettled ? `: ${states.join("; ")}` : ""}`;
    // Leave room for the remainder line itself, or a long tail would push the note over
    // the budget in the act of admitting it has one. DERIVED from the line's own format,
    // not a constant: the reserve here was 60 while the line it reserves for is about
    // 70, so the collapsed form could overshoot by ten characters. The older, shorter
    // header left enough slack to hide that; growing the header is what exposed it.
    if (lines.length > 0 && used + line.length + remainderReserve > RECOVERY_NOTE_BUDGET) {
      restTools++;
      restCalls += c.calls;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (restTools > 0) lines.push(remainder(restTools, restCalls));
  return lead + lines.join("\n");
}

/**
 * Rebuild the ledger from a reply's persisted parts.
 *
 * The in-memory ledger is only as durable as the process holding it, and a turn in
 * this system is a durably queued row that can be picked up again — an approval or
 * `ask` continuation is literally a SECOND task writing the SAME message row. Its
 * first half's tool calls are in the row, not in this process's memory, so without
 * this the continuation starts with an empty ledger and the recovery note it might
 * later need would omit everything the first half did.
 *
 * Paired by tool-call id, because the arguments live on the CALL and the evidence
 * that it ran lives on the result (or the error): a `tool-call` with neither is
 * still in flight — or was suspended for approval and never executed — and must
 * not be reported as done.
 */
export function effectsFromParts(parts: StoredPart[]): TurnEffect[] {
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const p of parts) {
    if (p.type === "tool-call") calls.set(p.id, { name: p.name, input: p.input });
  }
  const out: TurnEffect[] = [];
  for (const p of parts) {
    if (p.type !== "tool-result" && p.type !== "tool-error") continue;
    // The SDK rejected this call before running it (unparseable arguments, unknown
    // tool) and synthesized the error itself, so it is not evidence that anything
    // happened. The live ledger already skips these and `recordEffect` is never
    // called for them — but this path is what a CONTINUATION reads, and mergeEffects
    // keeps a parts-only entry precisely because the table has no row for it. So
    // without this the restarted half is told "this already ran, do not repeat"
    // about work that never ran, and the row goes silently unwritten: the omission
    // that is worse than the duplication this module exists to prevent. Fourth
    // reader of one fact — see producedWork and PRODUCED_WORK_SQL for the others.
    if (p.type === "tool-error" && p.invalid) continue;
    const call = calls.get(p.id);
    out.push({
      id: p.id,
      name: call?.name ?? p.name,
      input: call?.input,
      ...(p.type === "tool-error" ? { failed: true } : {}),
    });
  }
  return out;
}

/**
 * A ledger write that did not land after its retries.
 *
 * A distinct type because the alternative is worse than failing: a Postgres blip
 * reads as `network` to `isTransientError`, so the stream loop would treat it as a
 * provider hiccup, re-stream, and carry on with the call unrecorded — losing
 * exactly the durability this module exists to provide. The runner checks for this
 * before its transient classification, so the turn fails closed instead.
 */
export class EffectLedgerError extends Error {}

/** A blip should cost a moment, not a turn; a dead database should fail the turn. */
const LEDGER_WRITE_ATTEMPTS = 3;

/**
 * Record one executed call, durably, against the reply it belongs to.
 *
 * Called on the result or the error — never on the request — so a row means "this
 * ran". Awaited rather than fired off, because the whole point is that the record
 * outlives the process: a restart that begins before the write lands is a restart
 * that starts blind, which is the failure this exists to prevent.
 *
 * Upsert, not insert: an approved call re-runs under the SAME tool-call id, and
 * its second outcome should replace the first rather than appear twice in a note
 * whose only job is to say what happened once.
 */
export async function recordEffect(e: EffectWrite): Promise<void> {
  return upsertEffect(e, true);
}

/**
 * Record one call the moment before it is entered, while its outcome is unknown.
 *
 * The write-ahead half, and the reason the ledger can describe the window it could
 * not before: `recordEffect` fires on the result, so a tool that starts, touches the
 * workspace and then loses its worker leaves NOTHING behind — not a ledger row, and
 * not a `parts` entry a restart can trust either, since an unanswered `tool-call` is
 * indistinguishable from one the SDK rejected before running. Writing at dispatch
 * turns that silence into "may have run; verify".
 *
 * Awaited by its caller BEFORE the tool is invoked, and the caller must refuse to
 * invoke it if this throws. A start row that lands after the side effect is the same
 * gap in a smaller window; one that never lands at all is the original bug.
 */
export async function recordEffectStarted(e: EffectWrite): Promise<void> {
  return upsertEffect(e, false);
}

interface EffectWrite {
  messageId: string;
  toolCallId: string;
  taskId: string;
  name: string;
  input: unknown;
  failed?: boolean;
}

async function upsertEffect(e: EffectWrite, settled: boolean): Promise<void> {
  // Sanitized HERE, not at the call sites: a model can emit a literal NUL escape
  // inside a valid JSON string argument, Postgres rejects it in jsonb, and a caller
  // that forgets would turn "this call ran" into a failed write. One place cannot
  // be forgotten in the next one.
  const row = { toolName: e.name, input: stripNul(e.input) ?? null, failed: e.failed ?? false, settled };
  let last: unknown;
  for (let attempt = 1; attempt <= LEDGER_WRITE_ATTEMPTS; attempt++) {
    try {
      await db.insert(messageEffects)
        .values({ messageId: e.messageId, toolCallId: e.toolCallId, producerTaskId: e.taskId, ...row })
        .onConflictDoUpdate({
          target: [messageEffects.messageId, messageEffects.toolCallId],
          // `failed` is sticky: "it threw" is the conservative reading, because a tool
          // that writes before it fails has already written. A later success under the
          // same id must not erase the one entry the note most needs to flag.
          //
          // `settled` is sticky for the mirror-image reason: an outcome, once known, is
          // the STRONGER statement about the same call, so a re-approved call entering
          // execute again must not downgrade "this ran" back to "this might have run".
          set: {
            ...row,
            failed: sql`${messageEffects.failed} or excluded.failed`,
            settled: sql`${messageEffects.settled} or excluded.settled`,
          },
        });
      return;
    } catch (err) {
      last = err;
      if (attempt < LEDGER_WRITE_ATTEMPTS) await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
  throw new EffectLedgerError(`could not record executed tool call ${e.toolCallId}: ${String(last)}`);
}


/**
 * Put every locally-executed tool behind a durable "this is about to run" record.
 *
 * THE BOUNDARY IS `execute`, deliberately, and the two nearby places it could go are
 * both wrong. The streamed `tool-call` event is too late and too loose: the consumer
 * processes it asynchronously while execution proceeds on its own, so the row can land
 * after the side effect. And the SDK's own `experimental_onToolCallStart` is invoked
 * through `notify()`, which wraps each callback in `try { … } catch (_ignored) {}` —
 * a lost write there fails OPEN and the tool runs unrecorded, which is the original
 * defect in a smaller window.
 *
 * Wrapping here also gets three exclusions for free, all of which a dispatch-time
 * record MUST honour:
 *   • a call the SDK rejected before running (unparseable arguments, unknown tool)
 *     never reaches execute, so it gets no row — telling a restarted turn "already
 *     ran" about work that never ran is the omission that is worse than a repeat;
 *   • `ask` has no execute at all, by design (the SDK ends the loop, which the runner
 *     turns into a durable suspend), and a tool without one is returned untouched;
 *   • a call awaiting native approval is suspended BEFORE execute, so an unapproved
 *     call is never recorded as started.
 *
 * B5's lesson is why the generator branch exists: wrapping every `execute` in an
 * `async` function once broke tools that return an async iterable, because the SDK
 * inspects the IMMEDIATE return value and an async wrapper hands it a promise. Every
 * tool in this repo currently declares `execute: async (…)`, so the promise branch is
 * the live one; the generator branch keeps the eventual streaming tool correct instead
 * of silently mis-shaping it. A plain function that returns an iterable without being
 * a generator is the residual case, and there is no way to detect it from here.
 */
export function withEffectLedger<T extends object>(
  tools: T,
  ctx: { messageId: string; taskId: string },
): T {
  const out: Record<string, unknown> = {};
  // Structural, not typed: the live tool set is heterogeneous (sandbox tools, MCP
  // connectors, provider-executed tools, `ask`) with optional keys, so "does it have a
  // callable execute" is the only question worth asking here, and it is a runtime one.
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: unknown } | null | undefined)?.execute;
    if (typeof execute !== "function") {
      out[name] = tool;
      continue;
    }
    const call = execute as (input: unknown, options: unknown) => unknown;
    const start = (options: unknown, input: unknown) =>
      recordEffectStarted({
        messageId: ctx.messageId,
        toolCallId: (options as { toolCallId: string }).toolCallId,
        taskId: ctx.taskId, name, input,
      });
    // `.call(tool, …)` rather than a bare call: the SDK binds `execute` to its own tool
    // object, and a tool that reads `this` would otherwise break only once it existed.
    const run = (input: unknown, options: unknown) => call.call(tool, input, options);

    out[name] = Object.getPrototypeOf(execute)?.constructor?.name === "AsyncGeneratorFunction"
      ? { ...tool, execute: async function* (input: unknown, options: unknown) {
          await start(options, input);
          yield* run(input, options) as AsyncIterable<unknown>;
        } }
      : { ...tool, execute: async (input: unknown, options: unknown) => {
          await start(options, input);
          return run(input, options);
        } };
  }
  return out as T;
}

/**
 * The ledger for one reply, oldest first.
 *
 * Ordered by `created_at` then tool-call id: `now()` is transaction time, so two
 * calls recorded inside one transaction would tie, and a note that reorders itself
 * between reads is a note nobody can diff. Chronology is what the model reads
 * ("continue from where they stopped"), so the tie-break exists to make the order
 * total, not to be meaningful on its own.
 */
export async function loadEffects(messageId: string): Promise<TurnEffect[]> {
  const rows = await db
    .select({ id: messageEffects.toolCallId, name: messageEffects.toolName, input: messageEffects.input, failed: messageEffects.failed, settled: messageEffects.settled })
    .from(messageEffects)
    .where(eq(messageEffects.messageId, messageId))
    .orderBy(asc(messageEffects.createdAt), asc(messageEffects.toolCallId));
  return rows.map((r) => ({
    id: r.id, name: r.name, input: r.input,
    ...(r.failed ? { failed: true } : {}),
    ...(r.settled ? {} : { unsettled: true }),
  }));
}


/**
 * How far up the branch the walk below will look. A chain of consecutive part-way
 * failures is already pathological at two; this is the guard that stops a long chat
 * from being walked to its root, not a tuning knob.
 */
const INHERIT_MAX_HOPS = 12;

/**
 * The effects of the replies this turn is continuing — the ones that failed part-way.
 *
 * The "Continue" button is not a continuation in the runner's sense. `resumeMessageId`
 * has exactly one producer, the approval/`ask` path, where a second task writes the SAME
 * reply row; Continue instead sends an ORDINARY user message, so the turn gets a fresh
 * message id and `message_effects` — keyed by message id — has no rows for it. The calls
 * it must not repeat belong to the PREVIOUS reply.
 *
 * Detected on the server from the reply's own recorded verdict rather than from a flag
 * the client sends. Both were designed; this one wins because the condition is already
 * durable (a part-way failure persists its category in the row), it cannot be forgotten
 * by a caller, and it covers the user who types their own follow-up instead of clicking
 * the button — that turn must not repeat those writes either. The cost is the mirror
 * case: someone who deliberately asks for the work to be redone still gets the note.
 *
 * The walk: up the parent chain, collecting every assistant reply whose verdict was a
 * partial failure, and STOPPING at the first one that completed. A completed reply is
 * the baseline — whatever ran before it was already accounted for by the turn that
 * succeeded — so continuing past it would drag a whole chat into the note. User
 * messages are transparent, which keeps this independent of how the tree is shaped.
 *
 * Oldest first, matching `mergeEffects`: an earlier reply's calls ran earlier.
 */
export async function loadInheritedEffects(fromMessageId: string): Promise<TurnEffect[]> {
  const collected: TurnEffect[][] = [];
  let cursor: string | null = fromMessageId;
  for (let hop = 0; hop < INHERIT_MAX_HOPS && cursor; hop++) {
    const [row] = await db
      .select({ parentId: messages.parentId, role: messages.role, metadata: messages.metadata })
      .from(messages).where(eq(messages.id, cursor)).limit(1);
    if (!row) break;
    if (row.role === "assistant") {
      const meta = (row.metadata ?? {}) as { errorCategory?: string; parts?: StoredPart[] };
      // The three partial verdicts all end this way (timed_out_partial,
      // interrupted_partial, provider_unresponsive_partial) — matching the suffix keeps
      // this from silently missing a fourth the day one is added.
      if (!meta.errorCategory?.endsWith("_partial")) break;
      // Both sources, ledger winning — the same union a resume performs, and for the
      // same reason: an emergency trim clears `parts` while keeping the ledger, and a
      // reply that predates the ledger lives only in `parts`.
      collected.push(mergeEffects(await loadEffects(cursor), effectsFromParts(meta.parts ?? [])));
    }
    cursor = row.parentId;
  }
  return collected.reverse().flat();
}

/**
 * Union the durable ledger with what could be rebuilt from `parts`, ledger winning.
 *
 * Not either/or, which was the first cut and was wrong: during a rolling upgrade one
 * message can hold effects in BOTH places — the half that ran before this table
 * existed is only in `parts`, the half after it only in the ledger — and an empty
 * ledger is also what a failed write leaves behind. Preferring one source silently
 * drops the other, and a dropped effect is precisely the one that gets done twice.
 *
 * Parts-only entries come first: an effect the ledger has never heard of predates
 * the ledger for this message, so that order is also the chronological one.
 */
export function mergeEffects(ledger: TurnEffect[], fromParts: TurnEffect[]): TurnEffect[] {
  const known = new Set(ledger.map((e) => e.id).filter((id): id is string => !!id));
  return [...fromParts.filter((e) => !e.id || !known.has(e.id)), ...ledger];
}
