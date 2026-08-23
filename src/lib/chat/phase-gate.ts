/**
 * When a live status label may change.
 *
 * A turn passes through stretches that produce no content of their own — queued,
 * connecting to the model, starting the sandbox — and naming them is only worth
 * doing when the wait is long enough to need explaining. Most of the time these
 * stretches are over in a few hundred milliseconds, and the label that announces
 * them is on screen barely long enough to be read as a flash of movement rather
 * than a word. That flash is worse than saying nothing: it draws the eye to text
 * that is gone before it can be understood.
 *
 * Two clocks, because the flicker has two ends and one clock only closes one:
 *
 *  - REVEAL — a phase must have been continuously active this long before its
 *    label may appear at all. Kills the blink on the way IN: a phase shorter than
 *    the threshold is never drawn.
 *  - DWELL — once a label is on screen it stays at least this long, whatever
 *    happens to the phase underneath it. Kills the blink on the way OUT: without
 *    it, a phase that ends one tick after crossing the reveal threshold would put
 *    a word up and take it away again immediately.
 *
 * Together they give one flat guarantee, which is the thing to hold onto: **no
 * label is ever visible for less than `dwellMs`.**
 *
 * The counterpart guarantee — that gating never leaves a HOLE — is not this
 * function's job and cannot be: it comes from the caller always having a fallback
 * label ("Thinking…") underneath. A phase REPLACES that word; it is never
 * something added into empty space. So there is nothing to leave behind.
 *
 * Pure, and returning `recheckIn` rather than owning a timer, for two reasons:
 * the caller already runs a one-second tick for its elapsed clock, and time-based
 * behaviour that lives inside a component cannot be tested at all in a `node`
 * environment. The correctness of these two clocks IS the feature.
 */
export interface PhaseGateInput<P extends string> {
  /** The phase the runner reports right now, or null between phases. */
  phase: P | null;
  /** When `phase` last changed to its current value. */
  phaseSince: number;
  /** The label currently on screen, or null. */
  shown: P | null;
  /** When `shown` was put on screen. Meaningless when `shown` is null. */
  shownAt: number;
  now: number;
}

export interface PhaseGateResult<P extends string> {
  shown: P | null;
  shownAt: number;
  /** Milliseconds until this needs deciding again, or null if nothing is pending.
   *  A caller that ignores it merely reacts late; it never renders a wrong state. */
  recheckIn: number | null;
}

export function gatePhase<P extends string>(
  { phase, phaseSince, shown, shownAt, now }: PhaseGateInput<P>,
  { revealMs = 1500, dwellMs = 1200 }: { revealMs?: number; dwellMs?: number } = {},
): PhaseGateResult<P> {
  // Already saying the right thing — including "saying nothing" when there is
  // nothing to say. No timer needed for a state that is not waiting on anything.
  if (phase === shown) return { shown, shownAt, recheckIn: null };

  const dwellLeft = shown === null ? 0 : Math.max(0, shownAt + dwellMs - now);

  // Nothing wants the slot; the label leaves as soon as it has served its dwell.
  if (phase === null) {
    return dwellLeft > 0
      ? { shown, shownAt, recheckIn: dwellLeft }
      : { shown: null, shownAt: 0, recheckIn: null };
  }

  // A phase wants the slot, either from empty or over another label. BOTH clocks
  // gate it: the newcomer must have earned its place, and the incumbent must have
  // had its time. Taking the max rather than one or the other is the whole point —
  // each clock alone leaves one of the two flicker modes open.
  const wait = Math.max(Math.max(0, phaseSince + revealMs - now), dwellLeft);
  return wait > 0 ? { shown, shownAt, recheckIn: wait } : { shown: phase, shownAt: now, recheckIn: null };
}
