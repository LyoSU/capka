/**
 * Fraction of the effective context window at which we start compacting. The
 * remaining headroom (1 - threshold) is reserved for the model's OWN output
 * (answer + reasoning tokens), which also counts against the window — so waiting
 * until ~95% would leave no room for a reply even when the input alone fits.
 */
export const COMPACT_THRESHOLD = 0.75;

/**
 * Conservative window assumed when the catalog reports no `contextLength` for a
 * model (a custom/local backend). Pessimistic on purpose: better to compact a
 * little early than to blow a window we couldn't measure. The reactive
 * `context_too_long` retry is the safety net behind this guess.
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
