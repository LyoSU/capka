/**
 * Compaction fires once the free room left in the window drops below a RESERVE:
 * this share of it, and at least `COMPACT_RESERVE_MIN`. The reserve is what the next
 * turn has for the user's new message, its tool steps and the model's own output
 * (answer + reasoning, which count against the window too), and for the summary
 * request itself, which outgrows the measured prompt by the reply it adds.
 *
 * A reserve, not a flat percentage, because a percentage scales the wrong way at
 * both ends: 75% of a 1M window left 250k tokens of usable context idle and
 * summarized conversations that were nowhere near full, while 25% of a 32k window
 * is 8k — less than one large file read. Real sessions grow by up to ~22k tokens
 * in a single step at p99 (opencode's measurement), which the 16k floor plus the
 * mid-turn prune (step-control) and the reactive emergency trim cover between them.
 */
export const COMPACT_RESERVE_SHARE = 0.15;
/** The least the reserve may be, in tokens — on any window big enough to give it up
 *  twice over (below 32k the share alone applies, or compaction would fire at 0). */
export const COMPACT_RESERVE_MIN = 16_000;

/** The prompt size, in tokens, at which a window of `effectiveLimit` compacts. The
 *  ONE place the trigger is computed, so the composer meter and the runner agree. */
export function compactAt(effectiveLimit: number): number {
  const floor = effectiveLimit >= 2 * COMPACT_RESERVE_MIN ? COMPACT_RESERVE_MIN : 0;
  return effectiveLimit - Math.max(Math.floor(effectiveLimit * COMPACT_RESERVE_SHARE), floor);
}

/**
 * No longer the trigger (that is `compactAt`); what is left is the runner's
 * re-entrancy floor — a summary estimated at this share of the window or more is
 * not checkpointed. 0.5 because that is the LOWEST share `compactAt` ever reaches
 * (exactly 32k, where the 16k reserve is half the window): a floor above the
 * trigger, as 0.75 would be on every window under ~64k, would checkpoint a summary
 * that trips compaction again on the very next turn. On large windows it is
 * stricter than the trigger, which costs nothing — a summary filling half the
 * window has failed at its one job anyway.
 */
export const COMPACT_THRESHOLD = 0.5;

/**
 * Window assumed when neither the catalog nor an earlier overflow has told us a
 * model's `contextLength` (a custom/local backend on its first turns). A guess,
 * and deliberately a one-shot one: the first overflow teaches the real figure
 * (parseContextWindow → rememberModelContextLength) and this stops applying.
 * 128k is where today's off-catalog models cluster; a larger model compacts a
 * little early until it overflows once (harmless), a smaller one pays a single
 * emergency-trimmed turn before its window is known. The previous 32k protected
 * that smaller case at the cost of compacting every unknown 200k+ model at 24k,
 * forever — and it never protected the truly small case anyway: Ollama's default
 * 4k window truncates the prompt silently rather than rejecting it, which no
 * default and no retry can see.
 */
export const DEFAULT_CONTEXT_LENGTH = 128_000;

export interface ContextBudget {
  /** Tokens we actually plan against: min(model window, admin cap), or the default. */
  effectiveLimit: number;
  /** Input tokens the last turn consumed (from the provider's usage report). */
  used: number;
  /** used / effectiveLimit. Can exceed 1 if we've already overrun the window. */
  fraction: number;
  /** The prompt size at which this window compacts (see compactAt). */
  compactAt: number;
  /** Whether the next turn should compact before running. */
  shouldCompact: boolean;
}

/**
 * Decide how full the context window is and whether to compact.
 *
 * The effective limit is the SMALLER of the model's real window and any
 * admin-configured cap — so an org can hold users to e.g. 200k even on a 1M
 * model (cost control), but a cap larger than the model's window is ignored
 * (we can never exceed what the model actually accepts).
 */
export function contextBudget(input: {
  usedTokens: number;
  modelContextLength?: number | null;
  adminCap?: number | null;
}): ContextBudget {
  const modelWindow = input.modelContextLength ?? DEFAULT_CONTEXT_LENGTH;
  // An admin cap only ever tightens the budget; it can't widen it past the model.
  const effectiveLimit = input.adminCap ? Math.min(modelWindow, input.adminCap) : modelWindow;
  const used = input.usedTokens;
  const trigger = compactAt(effectiveLimit);
  return {
    effectiveLimit,
    used,
    fraction: used / effectiveLimit,
    compactAt: trigger,
    shouldCompact: used >= trigger,
  };
}
