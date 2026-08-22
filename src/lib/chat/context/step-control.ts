import { pruneMessages, type ModelMessage } from "ai";
import { TOOL_CLEAR_KEEP_LAST } from "./provider-edits";

/**
 * Hard cap on tool-calling steps in one turn (streamText's `stopWhen`). Prevents a
 * model that keeps calling tools from looping forever. Raise MAX_AGENT_STEPS for
 * workflows that legitimately chain many tool calls.
 */
export const MAX_STEPS = Number(process.env.MAX_AGENT_STEPS) || 25;

/**
 * After this many tool steps WITHIN a single turn, force the model to answer in
 * text. Kept a few steps BELOW the hard cap, so a long tool loop produces a real
 * reply instead of being cut off mid-tool at the ceiling.
 *
 * Derived by default, not fixed: a hardcoded threshold above a lowered
 * MAX_AGENT_STEPS would never fire, and the turn would hit the ceiling mid-tool —
 * the very failure this exists to prevent. The floor of 1 keeps the wrap-up step
 * meaningful even at a cap of 1 or 2.
 *
 * But `cap - 5` is only a sane default while the cap is small. An operator who
 * raises MAX_AGENT_STEPS to 200 for legitimate bulk work also pushes wrap-up to
 * step 195 — deferring it past the point where it could do any good, since the
 * turn's context is long since spent. FORCE_TEXT_AFTER_STEPS is therefore its own
 * knob, clamped to the cap so a too-high value can't disable it outright.
 */
export const FORCE_TEXT_AFTER_STEPS = Math.min(
  MAX_STEPS,
  Math.max(1, Number(process.env.FORCE_TEXT_AFTER_STEPS) || MAX_STEPS - 5),
);

/**
 * The wall-clock twin of FORCE_TEXT_AFTER_STEPS: the fraction of a task's run-time
 * budget after which the turn stops calling tools and answers with what it has.
 *
 * 0.8 leaves a fifth of the budget to write the answer in — at the default deadline
 * that is two minutes, comfortably more than a wrap-up reply needs, and short enough
 * that the brake doesn't cost a turn much of its working time. Clamped BELOW 1
 * because a fraction of 1 would arm the brake at the same instant the deadline
 * aborts the run, which is no brake at all.
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
 * Per-step settings for streamText's prepareStep hook.
 *
 * CACHE NOTE: this deliberately NEVER returns `messages`. Rewriting the message
 * array between steps would change the prompt prefix on every step and break the
 * prompt cache mid-turn (the exact trap from "Don't Break the Cache"). Switching
 * `toolChoice` does invalidate the cache once — but only on this single late
 * step, where the turn is wrapping up anyway, so the cost is one-off, not
 * per-step. Hence the only lever here is a late `toolChoice: 'none'`.
 *
 * TWO ceilings arm it, because a turn can run out of either budget first. The step
 * count is the one a chatty model exhausts; the wall clock is the one heavy sandbox
 * work exhausts, and it usually gets there first — MAX_STEPS tool calls at the
 * controller's per-exec timeout can exceed the task deadline on their own, so a turn
 * doing real work hits the clock with steps to spare. Left to the deadline alone,
 * that turn is aborted mid-tool and the reply is a hard cut; braking a little early
 * turns the same run into a real answer that says what it got done.
 */
export function stepSettings(
  stepNumber: number,
  /** How much of the task's wall-clock budget is spent, 0..1. Zero = no clock pressure. */
  elapsedFraction = 0,
): { toolChoice?: "none" } {
  return stepNumber >= FORCE_TEXT_AFTER_STEPS || elapsedFraction >= WRAP_UP_AFTER_FRACTION
    ? { toolChoice: "none" }
    : {};
}

/**
 * Shed the tool traffic accumulated before `boundary` (an absolute index into this
 * step's message list), keeping everything from there on intact.
 *
 * This is the hole the rest of the context machinery left open. Compaction is
 * evaluated at a turn BOUNDARY and buildModelContext clears at turn BUILD, so a
 * single turn that keeps calling tools had exactly one thing standing between it
 * and the ceiling: Anthropic's server-side edit, which no other provider gets.
 * A turn that starts at 74% of the window sails past 75% and on to the hard limit
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
 * Message-scoped rather than tool-scoped: the SDK's pruner counts messages, and a
 * tool loop appends roughly one assistant + one tool message per exchange. Using
 * its own pruner is what guarantees calls and results are dropped as PAIRS — an
 * orphaned tool result is a hard 400 on Anthropic and OpenAI alike.
 */
export function pruneTurnToolTraffic(messages: ModelMessage[], boundary: number): ModelMessage[] {
  const keepLast = messages.length - boundary;
  if (boundary <= 0 || keepLast <= 0) return messages;
  return pruneMessages({ messages, toolCalls: `before-last-${keepLast}-messages` });
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
 * Invalidating the boundary itself is the CALLER's job, not this function's: a
 * boundary is only meaningful against the list it was measured on, and only the code
 * that starts a stream knows the list was replaced. This decides where to cut, and
 * refuses to move the cut without a measurement from the stream it is cutting.
 */
export function armPruneBoundary(input: {
  triggerAt: number;
  boundary: number;
  lastStepContextTokens: number;
  messageCount: number;
  stepNumber: number;
}): number {
  if (input.triggerAt <= 0) return 0;
  if (input.stepNumber === 0) return input.boundary;
  if (input.lastStepContextTokens < input.triggerAt) return input.boundary;
  return Math.max(input.boundary, input.messageCount - TOOL_CLEAR_KEEP_LAST);
}
