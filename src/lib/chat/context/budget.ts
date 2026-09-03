/**
 * Fraction of the effective context window at which we start compacting. The
 * remaining headroom (1 - threshold) is reserved for the model's OWN output
 * (answer + reasoning tokens), which also counts against the window — so waiting
 * until ~95% would leave no room for a reply even when the input alone fits.
 */
export const COMPACT_THRESHOLD = 0.75;

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
  const fraction = used / effectiveLimit;
  return {
    effectiveLimit,
    used,
    fraction,
    shouldCompact: fraction >= COMPACT_THRESHOLD,
  };
}
