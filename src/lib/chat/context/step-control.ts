import type { ModelMessage } from "ai";
import { steerFrame, type WrapUpReason } from "@/lib/chat/contracts";
import { TOOL_CLEAR_KEEP_LAST } from "./provider-edits";
import { CLEARED_TOOL_INPUT, CLEARED_TOOL_OUTPUT } from "./tool-clearing";
import { outputBytes, MAX_TURN_TOOL_OUTPUT_CHARS } from "@/lib/tool-output";
import { posInt } from "@/lib/config/env";

/**
 * Hard cap on tool-calling steps in one turn (streamText's `stopWhen`). Prevents a
 * model that keeps calling tools from looping forever.
 *
 * 100, not the 25 this started at. 25 was below what a real office task takes on
 * current models — read eight attached files, cross-check them, build a deliverable
 * — and a turn that ran out of steps stopped with the work half-done. The step count
 * is not the guard that matters anyway: the wall clock (TASK_TIMEOUT_MINUTES, braked
 * by WRAP_UP_AFTER_FRACTION) bounds how long a turn runs, and the per-turn tool-output
 * budget (MAX_TURN_TOOL_OUTPUT_CHARS) bounds how much it reads. This one is left as
 * the backstop against a model that loops on cheap, fast calls neither of those sees.
 */
export const MAX_STEPS = posInt(process.env.MAX_AGENT_STEPS, 100);

/**
 * After this many tool steps WITHIN a single turn, force the model to answer in
 * text. Kept a few steps BELOW the hard cap, so a long tool loop produces a real
 * reply instead of being cut off mid-tool at the ceiling.
 *
 * Derived by default, not fixed: a hardcoded threshold above a lowered
 * MAX_AGENT_STEPS would never fire, and the turn would hit the ceiling mid-tool —
 * the very failure this exists to prevent.
 *
 * `cap - 5` stays the default at a cap of 100. The worry that once made it a
 * separate knob — that wrap-up at step 195 of 200 comes after the context is spent —
 * no longer leans on this number: the per-turn tool-output budget and the mid-turn
 * prune bound the context, and the clock brake usually fires long before step 95.
 * So this is the last of three brakes, and the only thing it must do is fire before
 * the cap. The five spare steps are for a provider that ignores `toolChoice: 'none'`
 * and calls a tool anyway: the forced steps that follow still carry the wrap-up
 * instruction, so it gets a few more chances to answer before the cap cuts it.
 *
 * Clamped to [1, cap - 1]. Step numbers run 0..cap-1, so a threshold AT the cap is
 * never reached — the ceiling stops the turn first, mid-tool, with nothing said.
 * (A cap of 1 has no room for a wrap-up step; the floor keeps that turn's single
 * step usable rather than forcing it to answer without ever looking.)
 */
export const FORCE_TEXT_AFTER_STEPS = Math.max(
  1,
  Math.min(MAX_STEPS - 1, Number(process.env.FORCE_TEXT_AFTER_STEPS) || MAX_STEPS - 5),
);

/**
 * The wall-clock twin of FORCE_TEXT_AFTER_STEPS: the fraction of a task's run-time
 * budget after which the turn stops calling tools and answers with what it has.
 *
 * 0.8 leaves a fifth of the budget to write the answer in — at the 20-minute default
 * deadline that is four minutes, comfortably more than a wrap-up reply needs, and
 * short enough that the brake doesn't cost a turn much of its working time. Clamped
 * BELOW 1 because a fraction of 1 would arm the brake at the same instant the
 * deadline aborts the run, which is no brake at all. A value outside the clamp is
 * warned about at boot (config/check.ts) rather than silently rewritten.
 */
export const WRAP_UP_AFTER_FRACTION = Math.min(
  0.95,
  Math.max(0.1, Number(process.env.WRAP_UP_AFTER_FRACTION) || 0.8),
);

/**
 * Fold `reasoning` parts of assistant messages INTO their text (returns a fresh
 * array; inputs without reasoning pass through). Used REACTIVELY after a backend
 * rejects the model's own echoed `reasoning_content`
 * (isReasoningEchoRejectedError).
 *
 * Why fold, not drop: `@ai-sdk/openai-compatible` serializes a `reasoning` part
 * as the `reasoning_content` field, which Cerebras 400s on input. But Cerebras'
 * gpt-oss is a reasoning model that needs its prior thinking to continue a
 * tool-calling turn — DROPPING it entirely just trades the 400 for a silent
 * hang. Cerebras' own docs say to retain reasoning by prepending it into
 * `content` instead (GPT-OSS: reasoning directly before the answer). Folding it
 * to a text part does exactly that: no `reasoning_content` field (no 400) and
 * the thinking survives in content (no stall). The tool-call part is kept so a
 * following tool result isn't orphaned.
 *
 * With tools the offending echo is an INTERMEDIATE assistant message that
 * streamText generates inside its own tool loop and re-feeds on the next step —
 * it never appears in the input `modelMessages`, so it can only be reached
 * per-step in prepareStep.
 */
export function foldReasoningIntoText(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const reasoning = m.content
      .filter((p): p is Extract<typeof p, { type: "reasoning" }> => p.type === "reasoning")
      .map((p) => p.text)
      .join("");
    if (!reasoning) return m;
    const rest = m.content.filter((p) => p.type !== "reasoning");
    const i = rest.findIndex((p) => p.type === "text");
    if (i >= 0) {
      // Immutable: don't mutate the part object AI SDK handed us in prepareStep.
      const merged = rest.map((p, j) =>
        j === i ? { ...p, text: `${reasoning}\n\n${(p as { text: string }).text}` } : p,
      );
      return { ...m, content: merged };
    }
    return { ...m, content: [{ type: "text", text: reasoning }, ...rest] };
  });
}

/**
 * Whether this step must answer in text instead of calling tools, and why —
 * `undefined` for an ordinary step.
 *
 * THREE ceilings arm it, because a turn can run out of any of them first. The step
 * count is the one a chatty model exhausts; the wall clock is the one heavy sandbox
 * work exhausts, and it usually gets there first — a turn doing real work hits the
 * clock with steps to spare. Left to the deadline alone, that turn is aborted
 * mid-tool and the reply is a hard cut; braking a little early turns the same run
 * into a real answer that says what it got done. The output budget is the third: a
 * turn whose tool results already add up past MAX_TURN_TOOL_OUTPUT_CHARS answers
 * with what it has instead of gathering more.
 *
 * `step` is counted across the whole TURN, not one stream: the runner re-streams on
 * a stall, a capability retry or an overflow trim, and the SDK's own step number
 * restarts at 0 on each. Read per stream, a stall after step 96 handed the turn a
 * fresh 95 steps and dropped the wrap-up the turn had already reached.
 *
 * The reason only matters for the record (an admin sees which limit fired). The
 * model is told the same thing in all three cases — see WRAP_UP_INSTRUCTION.
 */
export function wrapUpReason(input: {
  step: number;
  /** How much of the task's wall-clock budget is spent, 0..1. */
  elapsedFraction?: number;
  /** Characters of tool output this turn has read so far. */
  outputChars?: number;
}): WrapUpReason | undefined {
  if (input.step >= FORCE_TEXT_AFTER_STEPS) return "steps";
  if ((input.elapsedFraction ?? 0) >= WRAP_UP_AFTER_FRACTION) return "time";
  if ((input.outputChars ?? 0) >= MAX_TURN_TOOL_OUTPUT_CHARS) return "output";
  return undefined;
}

/**
 * What the model reads on the step its tools are taken away.
 *
 * Without it `toolChoice: 'none'` is silent: the model is stripped of its tools and
 * never told why, so it either writes an ordinary "done" that hides the unfinished
 * half, announces "next I'll do X" and stops, or says nothing at all — and the person
 * reading it, who is not technical, sees the work stop with no way forward.
 *
 * Phrased for the reply it produces, which an office worker reads: outcome first,
 * files by their `/workspace/…` path (the interface turns those into download cards),
 * then what is left and the one thing to do about it. No "steps" or "limits" — that
 * is machinery, and it reads as the product breaking. Framed as coming from the
 * system for the same reason a steer is framed as coming from the user: it rides in a
 * `user` message (the only role every provider accepts after a tool result), and
 * unframed it would read as the person's own words.
 */
export const WRAP_UP_INSTRUCTION =
  "[System note — not from the user] You can't use tools for the rest of this reply: no running code, no reading or writing files, no searching. "
  + "Answer now, in text only, in the language you have been using with the user. "
  + "Lead with the outcome: say plainly what is finished and where the results are, naming each file you made by its /workspace/… path as usual. "
  + "Then say what is not finished yet, and that if they ask you to continue you will pick up where you left off. "
  + "Don't announce or promise anything for this reply that you would need tools for. "
  + "Don't mention steps, limits, tools or how you work — if something is left, just say it needs another go to finish.";

/**
 * Append the wrap-up instruction to ONE step's prompt.
 *
 * Appended, never spliced: on Claude models that return thinking blocks, changing
 * anything before the last returned thinking block is a hard 400, and the tail is
 * the one place nothing has been returned after. The end is also the one legal spot
 * after a tool result (see injectSteers) — a run of user messages it forms with a
 * steer or a resume request is folded by `mergeUserRuns`.
 *
 * Not re-placed at a fixed index like a steer, because it is not part of the turn's
 * history: it is this step's instruction and nothing else. A `messages` value from
 * `prepareStep` is that step's prompt and is never fed back into the SDK's own
 * history, so it is never persisted, never shown, and never replayed into the next
 * turn or the compaction summary (both are built from the stored parts). A step that
 * is forced again — a provider that called a tool anyway, a re-stream after a stall —
 * gets it appended afresh at its own tail, so it is present exactly once per request.
 *
 * Cache: appending cannot change a single byte before it, so every prefix a cache
 * could hit is untouched. The step it lands on is a cache miss anyway — on the
 * Anthropic provider `toolChoice: 'none'` drops the `tools` array from the request
 * outright, and tools head the cached prefix; on Anthropic via a gateway that keeps
 * the tools, Anthropic documents a `tool_choice` change as invalidating the cached
 * messages. Other providers cache by prefix, which an append leaves whole. The instruction
 * itself is a few hundred bytes of uncached input on a request that ends the turn.
 */
export function appendWrapUp(messages: ModelMessage[]): ModelMessage[] {
  return [...messages, { role: "user", content: WRAP_UP_INSTRUCTION }];
}

/**
 * Clear the tool traffic accumulated before `boundary` (an absolute index into this
 * step's message list), keeping everything from there on intact.
 *
 * This is the hole the rest of the context machinery left open. Compaction is
 * evaluated at a turn BOUNDARY and buildModelContext clears at turn BUILD, so a
 * single turn that keeps calling tools had exactly one thing standing between it
 * and the ceiling: Anthropic's server-side edit, which no other provider gets.
 * A turn that starts just under the compaction point sails past it and on to the hard limit
 * with nothing but the reactive `context_too_long` retry to catch it — and that
 * retry re-streams from a blind mechanical trim, which is a far worse outcome
 * than shedding some old tool bodies here.
 *
 * An ABSOLUTE boundary, re-applied on every step, and that is the whole design.
 * A `messages` value returned from `prepareStep` is that step's prompt and nothing
 * more: the SDK assigns `initialMessages` once, outside its step loop, and rebuilds
 * `[...initialMessages, ...responseMessages]` per step, so it never sees what we
 * returned last time. Pruning "once" therefore bought a single step of headroom and
 * paid for it twice over — the prompt shape changed for that call and changed back
 * on the next one, two cache transitions for one step of relief, with the turn
 * unprotected from there on. Re-applying a FIXED cut instead keeps the pruned
 * prefix byte-identical from step to step, so the cache goes on hitting and the
 * relief lasts the rest of the turn.
 *
 * CLEARED, not dropped — the same placeholders the turn-build policy and Anthropic's
 * `clear_tool_uses` leave behind. The call keeps its name and id and the result its
 * slot, so the model still sees that each write HAPPENED; the SDK's `pruneMessages`
 * removed both, and a write loop that can no longer see its earlier writes does them
 * again. Nothing is removed, so no result can be orphaned from its call (a hard 400
 * on Anthropic and OpenAI alike). As in `clearStaleToolResults`, a call is cleared
 * exactly when its result is: one whose result sits past the cut stays whole, and an
 * error result keeps both halves (small and high-signal). Provider-executed results
 * ride in the assistant message and are left to the provider that replays them.
 *
 * The cleared arguments are an OBJECT, not the bare string the build path stores:
 * Anthropic-shaped `tool_use.input` and Gemini's `functionCall.args` must be one.
 */
export function pruneTurnToolTraffic(messages: ModelMessage[], boundary: number): ModelMessage[] {
  if (boundary <= 0 || boundary >= messages.length) return messages;
  const live = new Set<string>();
  for (const m of messages.slice(boundary)) {
    if (m.role === "tool") for (const p of m.content) if (p.type === "tool-result") live.add(p.toolCallId);
  }
  const stale = new Set<string>();
  for (const m of messages.slice(0, boundary)) {
    if (m.role !== "tool") continue;
    for (const p of m.content) {
      if (p.type === "tool-result" && !live.has(p.toolCallId)
        && (p.output.type === "text" || p.output.type === "json" || p.output.type === "content")) {
        stale.add(p.toolCallId);
      }
    }
  }
  if (stale.size === 0) return messages;
  return messages.map((m, i) => {
    if (i >= boundary) return m;
    if (m.role === "assistant" && typeof m.content !== "string") {
      if (!m.content.some((p) => p.type === "tool-call" && stale.has(p.toolCallId))) return m;
      return { ...m, content: m.content.map((p) =>
        p.type === "tool-call" && stale.has(p.toolCallId) ? { ...p, input: { note: CLEARED_TOOL_INPUT } } : p) };
    }
    if (m.role === "tool") {
      if (!m.content.some((p) => p.type === "tool-result" && stale.has(p.toolCallId))) return m;
      return { ...m, content: m.content.map((p) =>
        p.type === "tool-result" && stale.has(p.toolCallId)
          ? { ...p, output: { type: "text" as const, value: CLEARED_TOOL_OUTPUT } } : p) };
    }
    return m;
  });
}

/**
 * A steer this turn has taken, with the absolute index it was placed at — or none
 * yet, for one that has just arrived and has not been placed by any step.
 */
export interface PlacedSteer {
  id: string;
  text: string;
  /** Absolute index into the step's REBUILT message list. Undefined until placed. */
  index?: number;
  /** Already a complete message — not the user's words, so not framed as a steer.
   *  A background-job notice rides the same placement (see background-jobs.ts). */
  raw?: boolean;
}

/**
 * Splice this turn's steers into the message list of ONE step.
 *
 * A steer has exactly one legal position when it first arrives: the END of the
 * list. It is a `user` message, and after a tool loop the tail is a tool message —
 * Anthropic's provider folds a run of tool + user messages into a single user turn,
 * so appending puts the text after the `tool_result` blocks, which is the one place
 * every provider accepts it. Anywhere earlier separates a `tool_use` from its
 * result and is a hard 400.
 *
 * Every LATER step then has to put it back, and put it back in the SAME PLACE. A
 * `messages` value returned from `prepareStep` is that step's prompt and nothing
 * else — the SDK rebuilds `[...initialMessages, ...responseMessages]` from its own
 * history each step and never sees what we returned last time. Re-APPENDING would
 * therefore move the steer past the assistant message that answered it (reversing
 * the causality the model reads) and change the prompt prefix on every step, which
 * is a cache miss per step for the rest of the turn. Re-inserting at the recorded
 * absolute index keeps the prefix byte-identical and the order true: the steer sits
 * between the tool result it followed and the assistant message it produced. This
 * is `pruneBoundary`'s trick with the sign flipped — same reason, same lifetime
 * (one stream: a re-stream rebuilds a different list, so the caller drops the
 * indices and lets the next step re-place them at the new tail).
 *
 * Earlier insertions shift later ones, which is why this walks the list once and
 * emits by index rather than splicing repeatedly: the recorded indices are all in
 * the coordinates of the UN-injected list, so they stay comparable to each other
 * and to the prune boundary no matter how many steers precede them.
 *
 * Pure: returns a new list and a new steer array, so the caller can hold the
 * updated indices for the next step without this function owning turn state.
 */
export function injectSteers(
  messages: ModelMessage[],
  steers: PlacedSteer[],
): { messages: ModelMessage[]; steers: PlacedSteer[] } {
  if (steers.length === 0) return { messages, steers };
  const placed = steers.map((s) => (s.index === undefined ? { ...s, index: messages.length } : s));
  const out: ModelMessage[] = [];
  for (let i = 0; i <= messages.length; i++) {
    for (const s of placed) {
      if (s.index === i) out.push({ role: "user", content: s.raw ? s.text : steerFrame(s.text) });
    }
    if (i < messages.length) out.push(messages[i]);
  }
  return { messages: out, steers: placed };
}

/**
 * Where to cut this turn's tool traffic — 0 until the turn has actually grown past
 * the trigger. Split out from the runner because it is the load-bearing decision
 * and the runner has no test file of its own.
 *
 * `triggerAt` is 0 for a provider that clears server-side: the two mechanisms would
 * otherwise fight over the same history and each pay a cache invalidation for it.
 *
 * The boundary only ever moves FORWARD (`Math.max`), which is what stops the
 * oscillation a naive re-decision would cause: pruning drops the next step's
 * measured prompt back under the trigger, so a re-measured gate would toggle
 * off/on and re-shape the prompt — and re-bill the cache — every other step. A
 * monotonic cut re-arms only when genuinely new traffic has pushed the prompt over
 * the line again, and each advance costs exactly one cache transition.
 *
 * `stepNumber` is what keeps the measurement honest. The caller's figure is written
 * when a step FINISHES, and stepNumber restarts at 0 for every new streamText call —
 * of which the runner has ten — so at step 0 the figure describes either nothing at
 * all or a prompt that no longer exists. Arming off the latter would cut a rebuilt
 * (and much shorter) message list down to its tail before the model had run once.
 *
 * Refusing to arm at step 0 AT ALL was too broad, though, and the cost landed on the
 * restart paths. A new stream resets the boundary — it indexes a list the SDK has
 * discarded — so a turn that had already earned the cut came back without it and
 * could not re-earn it until step 1. That unbraked step is the first request after an
 * overflow: the one least able to afford it.
 *
 * `armedEarlier` is what separates the two states the step counter had flattened
 * together. A turn on its FIRST stream has accumulated no tool traffic of its own and
 * is upstream compaction's business, so it waits. A turn whose earlier stream crossed
 * the trigger has, and re-arms at once — off a fresh local count of the list in hand
 * rather than the stale report, because the rebuilt list carries the same TOKENS even
 * when its message count collapsed.
 *
 * Deliberately narrow: `armedEarlier` gates the estimate rather than the estimate
 * standing alone. The estimate over-counts prose (see BYTES_PER_TOKEN), and an
 * ungated step-0 arm would shed a long chat's history before the model had run once,
 * on a turn that never needed relief. Both conditions must hold.
 *
 * Invalidating the boundary itself is the CALLER's job, not this function's: a
 * boundary is only meaningful against the list it was measured on, and only the code
 * that starts a stream knows the list was replaced. This decides where to cut, and
 * refuses to move the cut without a measurement from the stream it is cutting.
 */
/**
 * How many messages one tool exchange occupies — the conversion the cut was missing.
 *
 * `TOOL_CLEAR_KEEP_LAST` counts tool USES, which is the unit Anthropic's server-side
 * edit takes. The cut counts MESSAGES, and a tool loop appends one
 * assistant message carrying the call(s) plus one tool message carrying the
 * result(s). Passing the use-count straight through therefore kept three MESSAGES —
 * about one and a half exchanges — where the shared policy says three exchanges, so
 * the mid-turn cut was roughly twice as destructive as the policy it claims to
 * share.
 *
 * 2 is exact for the sequential loop, not a rounding: one assistant + one tool
 * message per step. Parallel calls share a single pair, so six messages then keeps
 * MORE than three tool uses — conservative in the direction that shortens nothing.
 */
const MESSAGES_PER_TOOL_EXCHANGE = 2;

export function armPruneBoundary(input: {
  triggerAt: number;
  boundary: number;
  /** The provider's figure for the last step that FINISHED — a ghost at step 0. */
  lastStepContextTokens: number;
  /** A local count of the list being sent right now (`estimatePromptTokens`). Never a
   *  ghost, but an estimate, so it yields to a measurement wherever one exists. */
  estimatedTokens?: number;
  messageCount: number;
  stepNumber: number;
  /** Did this TURN arm the cut in a stream that has since been replaced? */
  armedEarlier?: boolean;
}): number {
  if (input.triggerAt <= 0) return 0;
  // At step 0 the reported figure is not merely unhelpful but WRONG — it describes a
  // prompt that no longer exists — so it is dropped rather than preferred. The local
  // count of the list in hand is the only honest figure there.
  const size = (input.stepNumber === 0 ? 0 : input.lastStepContextTokens) || input.estimatedTokens || 0;
  if (size < input.triggerAt) return input.boundary;
  if (input.stepNumber === 0 && !input.armedEarlier) return input.boundary;
  // No clamp at 0 needed, and one was briefly here: `boundary` starts at 0 and only
  // moves forward, so Math.max against it already floors the result. A rebuilt history
  // shorter than what the policy keeps therefore yields a cut of 0 — no cut — which is
  // the invariant that matters and is asserted through pruneTurnToolTraffic.
  return Math.max(input.boundary, input.messageCount - TOOL_CLEAR_KEEP_LAST * MESSAGES_PER_TOOL_EXCHANGE);
}

/**
 * UTF-8 bytes per token.
 *
 * Measured, not inherited, and the measurement is why this is 3. On o200k over
 * content taken from this repo: English prose 4.2-4.4 bytes per token, Ukrainian
 * prose 4.8-5.1, TypeScript source 4.2 — so `/4` is a fair-to-generous divisor for
 * PROSE in any script. Dense JSON is the outlier, and dense JSON is what this
 * function almost entirely counts: tool-call arguments measured 3.4-3.8 and a
 * serialized `package.json` as a tool result measured 2.58.
 *
 * That is the term the previous divisor missed. `8cd630e` moved this from characters
 * to bytes to stop under-counting Cyrillic, and correctly rejected a flat `/2` as
 * over-counting ASCII by 2x — but it reasoned entirely about SCRIPT, and carried
 * "4 still holds for Latin" over from the English chars-per-token rule of thumb
 * without re-checking it. Content TYPE turns out to matter more than script here:
 * every script's prose sits above 4 and structured JSON sits near 2.6.
 *
 * Claude's tokenizer is the less efficient of the two — a documented ~15-20% more
 * tokens for the same text than tiktoken — which moves every figure above further
 * down. Treated as margin rather than as the basis, since it is not measured here:
 * 3 is already below every JSON figure on o200k alone.
 *
 * A SMALLER divisor over-counts tokens, which is the direction to err in — see
 * estimatePromptTokens. Exported so a test can pin that direction rather than the
 * literal: any value that keeps the estimate above dense JSON's real cost is
 * correct, and 4 is not one of them.
 */
export const BYTES_PER_TOKEN = 3;

/**
 * Roughly how many tokens the prompt we are about to send is worth.
 *
 * Exists for one job: arming the mid-turn brake on an endpoint that reports no
 * usage. A gateway that rejects `stream_options` makes the runner re-stream with
 * usage reporting off for the rest of that connection, so the measured figure stays
 * 0 and can never cross a positive trigger — leaving the brake permanently
 * disengaged on precisely the providers that have no server-side edit either.
 *
 * Deliberately NOT written to `contextTokens`: that stays the one measured number
 * the (i) popover and the context meter report, and an estimate standing next to it
 * would make the two disagree for no gain.
 *
 * Text, reasoning and tool traffic only. A file part carries base64 whose LENGTH is
 * nothing like its token cost — an image is ~1.5k tokens and ~200k characters — so
 * counting it would arm the brake off an artifact of the encoding. Undercounting
 * attachments is also the safe direction: the brake sheds TOOL traffic, which is
 * not what an attachment is.
 *
 * UTF-8 BYTES, not characters, and that is the whole reason this is not `/4` over
 * `.length`. Four characters per token is an English ratio; Cyrillic runs closer to
 * two, so a character-based estimate undercounts a Ukrainian conversation by 2–4×
 * and a real 120k-token chat measures as 60k — never crossing the trigger, leaving
 * the brake absent exactly where this product treats the locale as first-class.
 * Bytes fix it without a locale to detect: Latin is one byte per character, Cyrillic
 * two, CJK three.
 *
 * Choosing bytes did not settle the DIVISOR, and the two questions were conflated
 * once already — see BYTES_PER_TOKEN for the measurement that separates them.
 *
 * Over-counting is the direction to err in, and the errors are not symmetric:
 * arming early sheds tool bodies a step or two sooner and costs one cache
 * transition, while arming late costs the TURN — the prompt reaches the ceiling, the
 * emergency trim fires, and the restart is the blind one this whole mechanism exists
 * to avoid. The early side is bounded too: this figure is consulted only where the
 * provider reports no usage at all, or at a step 0 whose reported figure describes a
 * prompt that no longer exists. A provider that reports is never armed off it.
 *
 * STILL UNCOUNTED, and named here rather than left for the next reader to rediscover:
 * the tool definitions. Names, descriptions and input schemas are sent alongside the
 * messages, never inside them, so a turn with forty connector tools carries several
 * thousand tokens this function cannot see. `estimateToolTokens` in
 * `lib/mcp/tool-search.ts` already sizes exactly that, for the deferral decision —
 * so the fix is to share one serializer across a module boundary, which is a
 * different change from the divisor and is deliberately not bundled with it.
 */
export function estimatePromptTokens(messages: ModelMessage[]): number {
  let bytes = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      bytes += Buffer.byteLength(m.content, "utf8");
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === "text" || p.type === "reasoning") bytes += Buffer.byteLength(p.text, "utf8");
      else if (p.type === "tool-call") bytes += outputBytes(p.input);
      else if (p.type === "tool-result") bytes += outputBytes(p.output);
    }
  }
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** How many steps a plan may sit untouched before the model is reminded of it. */
const PLAN_STALE_STEPS = 4;

/**
 * A one-step reminder that the checklist on the user's screen has gone stale.
 *
 * The model makes a plan, then works for twenty steps without touching it, and the
 * user watches "step 1 of 6" beside work that is plainly on step 5. The tool's
 * description and its result both ask for updates and are read once, at the start;
 * this is read at the moment it applies. Every PLAN_STALE_STEPS steps since the
 * last `update_plan` that left something open, and never once all of it is done.
 *
 * Appended like the wrap-up (see appendWrapUp), for the same reasons: it is this
 * step's instruction, not history, and an append leaves every cached prefix whole.
 */
export function planReminder(
  steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string; input: unknown }> }>,
): string | undefined {
  const at = steps.findLastIndex((s) => s.toolCalls.some((c) => c.toolName === "update_plan"));
  if (at < 0) return undefined;
  const stale = steps.length - 1 - at;
  if (stale === 0 || stale % PLAN_STALE_STEPS !== 0) return undefined;
  const plan = steps[at].toolCalls.findLast((c) => c.toolName === "update_plan")?.input as
    { steps?: Array<{ title?: string; status?: string }> } | undefined;
  const current = plan?.steps?.find((s) => s.status !== "done");
  if (!current?.title) return undefined;
  return `[System note — not from the user] The checklist on the user's screen still shows "${current.title}" as the step in progress. `
    + "If the work has moved past it, call update_plan with the current state in the same step as your next tool calls; if not, carry on. Don't mention this note.";
}
