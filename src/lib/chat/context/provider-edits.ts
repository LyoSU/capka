/**
 * Provider-native context-management knobs, kept separate from our own
 * checkpoint compaction so the two layers compose. Some providers can clear or
 * compact context server-side, cache-coherently — far better than us mutating
 * the prefix client-side. Today only Anthropic exposes this; the switch is the
 * extension point for OpenAI/Google equivalents as they ship, without touching
 * the runner.
 *
 * We use Anthropic's `clear_tool_uses` (drop old tool results in the FRESH zone
 * between checkpoints — the cheap lever our LLM compaction doesn't cover) but
 * deliberately NOT their native `compact_20260112`: our checkpoint compaction is
 * the single cross-provider mechanism, so the conversation tree and UX stay
 * identical regardless of provider.
 */

import type { MessageMeta } from "@/lib/chat/contracts";

/**
 * The tool-result clearing policy, in ONE place. Anthropic enforces it
 * server-side through the edit below; every other provider gets the same policy
 * applied to the context we build (`buildModelContext`'s `clearToolsKeepLast` —
 * see the runner). Kept shared so the behaviour can't fork by provider, and so
 * moving the threshold moves both halves at once.
 *
 * Fires well before the 75% compaction threshold: shedding stale tool bodies is
 * the cheap relief, and compaction handles whatever is left.
 */
export const TOOL_CLEAR_TRIGGER_FRACTION = 0.5;
/** How many of the most recent tool results keep their bodies. */
export const TOOL_CLEAR_KEEP_LAST = 3;
/**
 * Absolute ceiling on the trigger, in tokens. The fraction alone scales the wrong
 * way: on a 1M-window model "half" is HALF A MILLION tokens of accumulated tool
 * traffic before anything is shed — long past where recall starts degrading, and
 * long past what it costs to replay that prefix on every step of a long tool loop.
 * The fraction still governs small windows (a flat 120k would never fire on 32k);
 * this only caps what "half" is allowed to mean on a large one.
 */
export const TOOL_CLEAR_TRIGGER_MAX = 120_000;

/** The clear trigger for a window, in tokens. The ONE place both enforcement
 *  sites read it from, so the threshold can't fork by provider. */
export function toolClearTrigger(effectiveLimit: number): number {
  return Math.min(Math.round(effectiveLimit * TOOL_CLEAR_TRIGGER_FRACTION), TOOL_CLEAR_TRIGGER_MAX);
}

/**
 * The trigger for shedding THINKING, which is deliberately NOT the trigger for
 * shedding tool traffic. Same fraction, no cap — and the cap is the whole point.
 *
 * `TOOL_CLEAR_TRIGGER_MAX` is right for tool traffic and inverted for thinking,
 * because the two edits have opposite economics. Shedding a stale tool body is
 * cheap relief: the body is replayed on every step until it goes, and recall
 * degrades while it stays. Shedding thinking is not relief at all until the turn
 * stops fitting — `clear_thinking_20251015` takes no `trigger`, so it applies on
 * every request, and the clearing point advances each step of a tool loop, paying
 * a cache transition per step to drop tokens that were being read at cache rate.
 *
 * Measured over the loop, clearing costs 15-58% more in billed token-equivalents
 * than carrying (cache read 0.1x, 5-minute write 1.25x), and the "otherwise the
 * turn doesn't fit" justification holds in 3 of 9 window/thinking-size regimes.
 * The cap is what put us in the other six: it makes "half" mean 120k, so on a 1M
 * window the gate fired at 12% — where headroom is not remotely the binding
 * constraint — and stayed on, because the decision is sticky by design.
 *
 * A fraction with no cap scales the way this edit needs: it fires late on a large
 * window, which is exactly where carrying thinking is affordable.
 */
export function thinkingClearTrigger(effectiveLimit: number): number {
  return Math.round(effectiveLimit * TOOL_CLEAR_TRIGGER_FRACTION);
}

/** True when the provider has no server-side tool-result clearing, so we must
 *  apply the policy ourselves when building the model's view of the context. */
export function clearsToolResultsClientSide(provider: string): boolean {
  return contextManagementOptions(provider, 0) === undefined;
}

/**
 * Whether to build this turn's context with tool-result bodies cleared, for a
 * provider that has no server-side edit of its own.
 *
 * The measurement is the previous turn's persisted prompt size — nothing new to
 * compute — but it can't be read naively, because clearing CHANGES what it
 * measures. Two rules keep that from turning into a loop:
 *
 *  • Sticky. A cleared turn is a smaller turn, so the very success of clearing
 *    pushes the next measurement back under the threshold. Deciding afresh each
 *    time gives full → cleared → full → cleared, replaying every tool body on
 *    every other turn and handing the prompt cache a different prefix each time —
 *    strictly worse than either steady state. Once it's on it stays on.
 *  • …until the next compaction checkpoint, where the history collapses into a
 *    summary and the model's view genuinely restarts small. Messages before the
 *    checkpoint are not part of that view, so they don't get a vote — which is
 *    also what stops "sticky" from meaning "forever".
 */
export function shouldClearToolResults(
  provider: string,
  path: { metadata: unknown }[],
  effectiveLimit: number,
): boolean {
  return clearsToolResultsClientSide(provider) && contextIsDeep(path, effectiveLimit);
}

/**
 * Has this conversation grown deep enough that shedding is worth its cost?
 *
 * The provider-blind half of the question above, split out because the SERVER-side
 * edits need it too: `shouldClearToolResults` answers "should WE clear", and returns
 * false for Anthropic by design — so asking it about depth on Anthropic answers the
 * wrong question and always says no. The two rules described above (sticky until the
 * next checkpoint) live here, since they are properties of the measurement, not of
 * who acts on it.
 *
 * Reads the newer `contextDeep` marker and the older `toolsCleared` one: before this
 * split, the decision's only name was the client-side action it caused, and a chat
 * already mid-flight must not flip when its marker changes name.
 */
export function contextIsDeep(path: { metadata: unknown }[], effectiveLimit: number): boolean {
  return deepPast(path, toolClearTrigger(effectiveLimit), true);
}

/**
 * The same question for thinking, at thinking's own threshold.
 *
 * Separate exported function rather than a trigger parameter on purpose: both a
 * limit and a trigger are plain numbers, so a shared signature makes passing the
 * wrong one a silent 2x error at a call site instead of a type error.
 *
 * It does NOT accept `toolsCleared` as sticky evidence, which `contextIsDeep`
 * does. That marker is only ever written by a provider with no server-side edit —
 * never by Anthropic, the only provider this gate reaches — so on a chat that
 * changed model mid-conversation it would carry stickiness earned at the LOWER
 * tool threshold into the higher thinking one, turning the edit on early and
 * permanently. `contextDeep` is this decision's own marker and the only one it
 * reads.
 */
export function thinkingIsDeep(path: { metadata: unknown }[], effectiveLimit: number): boolean {
  return deepPast(path, thinkingClearTrigger(effectiveLimit), false);
}

function deepPast(path: { metadata: unknown }[], trigger: number, acceptToolsCleared: boolean): boolean {
  const metas = path.map((r) => r.metadata as MessageMeta | null);
  const live = metas.slice(metas.findLastIndex((m) => m?.compaction) + 1);
  if (live.some((m) => m?.contextDeep || (acceptToolsCleared && m?.toolsCleared))) return true;
  const lastMeasured = live.map((m) => m?.contextTokens).findLast((t): t is number => typeof t === "number");
  return (lastMeasured ?? 0) >= trigger;
}
/**
 * Whether to also clear old thinking blocks, and why it needs a gate of OUR own.
 *
 * Opus 4.5+ and Sonnet 4.6+ keep ALL prior thinking by default, so reasoning
 * accumulates for the life of a conversation. But `clear_thinking_20251015` takes no
 * `trigger` — unlike tool clearing it applies on EVERY request — and per the docs
 * the cache is invalidated at the point where clearing occurs. Inside a tool loop
 * every step adds a thinking turn, so the cleared SET changes each step and the
 * cache never settles: attaching it unconditionally pays a transition per step to
 * shed tokens that were being read at cache rate anyway.
 *
 * So it is attached only once the conversation is deep — at `thinkingClearTrigger`,
 * which is NOT the threshold tool clearing uses. It shared that threshold until the
 * cost was measured, and the shared number was the defect: the tool trigger is capped
 * at 120k, so on a 1M window this gate fired at 12% and, being sticky, stayed on.
 *
 * Measured (see `thinkingClearTrigger`): clearing costs 15-58% more than carrying,
 * and pays only where the alternative is a turn that does not fit. That is a
 * threshold question, not a yes/no one — which is why the answer was neither "stop
 * attaching this" nor "widen `keep`", the two options the unmeasured version offered.
 */
export const THINKING_KEEP_TURNS = TOOL_CLEAR_KEEP_LAST;

export function contextManagementOptions(
  provider: string,
  effectiveLimit: number,
  deep = false,
): Record<string, unknown> | undefined {
  switch (provider) {
    case "anthropic":
      return {
        anthropic: {
          contextManagement: {
            edits: [
              // FIRST when present — the docs require clear_thinking to lead the
              // array when strategies are combined.
              ...(deep
                ? [{
                    type: "clear_thinking_20251015",
                    keep: { type: "thinking_turns", value: THINKING_KEEP_TURNS },
                  }]
                : []),
              {
                type: "clear_tool_uses_20250919",
                trigger: { type: "input_tokens", value: toolClearTrigger(effectiveLimit) },
                keep: { type: "tool_uses", value: TOOL_CLEAR_KEEP_LAST },
                clearAtLeast: { type: "input_tokens", value: 1000 },
                // Clear the CALL's arguments too, not just its result. Defaulting to
                // results-only quietly aims the whole mechanism at the lighter half of
                // the data: on a bulk-write turn (a hundred upserts, each carrying a
                // full row) the result is an id and a status while the arguments ARE
                // the payload. Without this the edit fires, sheds a few hundred tokens,
                // and the window keeps filling — which is exactly how a turn reaches
                // 1M with the edit enabled the whole time.
                clearToolInputs: true,
              },
            ],
          },
        },
      };
    default:
      return undefined;
  }
}

/**
 * Return `messages` with the cache breakpoint moved onto the step tail.
 *
 * The turn's message-level marker is pinned to the last USER message, so
 * everything a tool loop appends after it sits beyond the last breakpoint and is
 * billed as fresh input on every step — the same tool results re-paid ~25 times
 * over a long loop. Marking the tail each step makes step N read at the cache rate
 * what step N-1 wrote.
 *
 * The tail is CLONED, never mutated, and that is the whole point: the SDK hands
 * back the same message objects each step, so an in-place marker would accumulate
 * one breakpoint per step and blow Anthropic's ceiling of four (stable + session +
 * user tail + this one is already exactly four). Step 0 is skipped — its tail is
 * the already-marked user message.
 */
export function markStepTail<T extends { providerOptions?: Record<string, Record<string, unknown>> }>(
  messages: T[],
  stepNumber: number,
  marker: Record<string, Record<string, unknown>>,
): T[] {
  const tail = stepNumber > 0 ? messages.at(-1) : undefined;
  if (!tail) return messages;
  // The cast is the price of staying generic over the SDK's message union: the
  // spread produces the same shape, TypeScript just can't say so for an open T.
  return [...messages.slice(0, -1), { ...tail, providerOptions: { ...tail.providerOptions, ...marker } } as T];
}

/** A provider-options object: a map of provider name → that provider's options. */
type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Deep-merge provider-options objects one level into each provider namespace,
 * so reasoning, context-management, and caching knobs that all target e.g.
 * `anthropic` combine into one `{ anthropic: { thinking, contextManagement, … } }`
 * instead of clobbering each other. Returns undefined when all are empty.
 */
export function mergeProviderOptions(
  ...opts: (ProviderOptions | undefined)[]
): ProviderOptions | undefined {
  let out: ProviderOptions | undefined;
  for (const o of opts) {
    if (!o) continue;
    if (!out) {
      out = { ...o };
      continue;
    }
    for (const [provider, po] of Object.entries(o)) {
      out[provider] = { ...(out[provider] ?? {}), ...po };
    }
  }
  return out;
}
