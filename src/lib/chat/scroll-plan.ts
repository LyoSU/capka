/**
 * The chat transcript's scroll decisions, as arithmetic over a snapshot.
 *
 * `useChatScroll` reads the DOM and writes to it; everything it DECIDES lives
 * here, taking plain numbers and returning plain numbers. The split is not
 * ceremony: the interesting behaviour is a state machine over geometry, and none
 * of it is testable while tangled with `getBoundingClientRect`. It is now.
 *
 * OWNERSHIP, NOT "SOMETHING CHANGED HEIGHT". The transcript's height changes for
 * dozens of reasons and the right response depends entirely on WHO caused it —
 * geometry alone cannot tell a reader expanding a spoiler from the model appending
 * a paragraph, because in both cases content grew below what they're looking at.
 * So every pass asks one question first: who owns the scroll position right now?
 *
 *   `reader`       nobody is driving. The reading line is held across every height
 *                  change above it; anything that grows below is just more to read.
 *   `interaction`  the reader just toggled something. The element they touched is
 *                  held exactly still until its animation finishes — this outranks
 *                  every other owner, and it is the only thing that can.
 *   `pin`          the question they just asked rests on the reading line while a
 *                  short reply grows beneath it.
 *   `tail`         a turn is streaming and the write head is held above the footer.
 *
 * Only a send takes `pin`; only streaming plus resting at the tail takes `tail`;
 * only a deliberate toggle takes `interaction`. Everything else is `reader`, which
 * is the safe default and the one the old implementation lacked entirely.
 *
 * COORDINATES. Every offset is measured from the top of the scroll container's box
 * (`el.getBoundingClientRect().top`), so `line` and `height` bound the visible band
 * and an offset of `line` means "resting on the reading line". Fractional
 * throughout — rounding is what let the spacer land exactly on the overflow
 * boundary and flip the scrollbar on and off with every streamed delta.
 */

export type ScrollOwner = "reader" | "interaction" | "pin" | "tail";

/** How a target should be reached. The distinction is the whole difference
 *  between polish and nausea: a correction exists to make a height change
 *  invisible, so animating it would animate the very thing it hides. */
export type ScrollMotion = "none" | "instant" | "ease";

/** How closely the pin target must already match the real position for the handoff
 *  to count as seamless. Once the spacer reaches zero those two agree to within
 *  rounding; a couple of pixels absorbs that without letting a genuinely displaced
 *  pin skip its correction. */
const HANDOFF_SLACK_PX = 2;

/** Below this, a correction is beneath the noise floor of fractional layout, and
 *  writing it would only produce a scroll event to re-interpret. */
const MIN_CORRECTION_PX = 1;

/** The content end counts as resting at the tail within this much of the rest
 *  line — pure rounding allowance, since `tail` holds it there to sub-pixel
 *  precision. Used to decide whether following may RESUME, which is why it is
 *  tight: a reader who expanded something at the end of the transcript is no
 *  longer at rest, and must not be dragged back down. */
const AT_REST_PX = 4;

/** Hysteresis for "the end of the conversation is on screen", which drives the jump
 *  pill. Leaving needs a couple of lines of travel, so the pill doesn't flicker
 *  while a reply streams across the boundary.
 *
 *  Entering shares `AT_REST_PX` rather than demanding a non-negative overshoot, and
 *  that is not a loosened tolerance — it is an invariant. `tail` and an explicit
 *  jump both rest the content end ON the line only to within rounding, which is
 *  exactly what `AT_REST_PX` exists to absorb. With a stricter entry threshold, a
 *  two-pixel residue meant the state could never be re-entered at all: arriving at
 *  the end left the pill on screen, still offering to take you where you already
 *  were. Resting at the tail must imply seeing the end. */
const END_VISIBLE_ENTER_PX = AT_REST_PX;
const END_VISIBLE_EXIT_PX = 48;

export interface ScrollSnapshot {
  owner: ScrollOwner;
  /** Container height, fractional (NOT `clientHeight`, which is rounded). */
  height: number;
  /** Top padding of the container — the reading line a pinned question rests on. */
  line: number;
  /** Footer reserve excluding the keyboard inset: the spacer's budget. That slack
   *  is deliberately left out, because it is the room the list rises into. */
  reserveNoKb: number;
  /** Footer reserve including it, so a followed reply clears the keyboard as well
   *  as the composer — and so "at the end" means at the end of what is VISIBLE. */
  reserveWithKb: number;
  scrollTop: number;
  /** Offset of the newest question's top, or null when there is no turn yet. */
  pinTop: number | null;
  /** Offsets of the content end (before the spacer). Null when not mounted. */
  contentEndTop: number | null;
  contentEndBottom: number | null;
  /** The spacer's current height, so a no-op write can be skipped. */
  spacerH: number;
  /** The held element's offset now, and what it was when last captured. Under
   *  `reader` this is the row crossing the reading line; under `interaction` it is
   *  the exact control the reader touched. */
  anchorNow: number | null;
  anchorWas: number;
  /** The reader is physically in charge of the scroller: a finger on the glass, a
   *  drag in progress, or iOS momentum still running. Writing into any of those is
   *  felt as a jolt, and WebKit only addresses that class of bug in Safari 27. */
  readerActive: boolean;
  /** One of our own eased scrolls is in flight, and owns the position. */
  animating: boolean;
  /** A turn is streaming. `tail` means nothing without one: "follow the write
   *  head" is only meaningful while something is writing, and leaving it armed
   *  while idle is what turned every late image and lazy syntax-highlight pass
   *  into a yank to the bottom. */
  streaming: boolean;
  /**
   * A chat with history is still assembling.
   *
   * Opening one lands at the end — but "the end" keeps moving for a while after
   * that: history arrives asynchronously, images decode, and the lazily imported
   * shiki/katex/mermaid chunk re-lays-out every code block and diagram in the whole
   * transcript. Every one of those grows content ABOVE the landing point, so
   * holding the reading line (the correct default at any other time) would faithfully
   * hold a position that is no longer the end, and the reader would open a long chat
   * to somewhere in its middle. While restoring, `tail` stays valid without a turn
   * streaming, so we keep re-landing until the layout goes quiet.
   */
  restoring: boolean;
  /** Previous value, for the hysteresis in `endVisible`. */
  wasEndVisible: boolean;
}

export interface ScrollPlan {
  /** New spacer height, or null when there is nothing to size or it already
   *  holds this value. */
  spacerH: number | null;
  owner: ScrollOwner;
  target: number | null;
  motion: ScrollMotion;
  /** Whether the end of the conversation is on screen — drives the jump pill. */
  endVisible: boolean;
  /** Whether the content end is resting at the tail, which is the only state from
   *  which following may resume by itself. */
  atRest: boolean;
}

/** How far the content end sits BELOW its resting line. Zero means exactly at
 *  rest; positive means there is more to scroll; negative means it is already
 *  above the line (a short reply held up by the spacer). */
export function tailOvershoot(s: ScrollSnapshot): number | null {
  if (s.contentEndBottom == null) return null;
  return s.contentEndBottom - (s.height - s.reserveWithKb);
}

/** At rest AT the tail — not merely "the end is somewhere on screen". These are
 *  different questions and conflating them is a bug: a short pinned reply has its
 *  end plainly visible while sitting nowhere near the rest line, and treating that
 *  as "at the tail" would let following resume and drag the reply upward. */
export function atRest(s: ScrollSnapshot): boolean {
  const o = tailOvershoot(s);
  return o != null && Math.abs(o) <= AT_REST_PX;
}

/** The end of the conversation is on screen. Hysteretic, so the jump pill doesn't
 *  flicker while a reply streams across the boundary. */
export function endVisible(s: ScrollSnapshot): boolean {
  const o = tailOvershoot(s);
  if (o == null) return s.wasEndVisible;
  return o <= (s.wasEndVisible ? END_VISIBLE_EXIT_PX : END_VISIBLE_ENTER_PX);
}

/** Room still missing for the newest question to reach the reading line — one
 *  viewport minus whatever already sits below it. Shrinks toward zero as the reply
 *  streams in, so a long answer leaves no dead space and a short one still lifts to
 *  the top. Floored, which is what guarantees it never crosses the overflow
 *  boundary: the principled version of the 2px undershoot this used to carry. */
export function spacerHeight(s: ScrollSnapshot): number | null {
  if (s.pinTop == null || s.contentEndTop == null) return null;
  const below = s.contentEndTop - s.pinTop;
  return Math.max(0, Math.floor(s.height - s.reserveNoKb - below - s.line));
}

/** Where the newest question comes to rest: on the reading line. */
export function pinTarget(s: ScrollSnapshot): number | null {
  return s.pinTop == null ? null : s.scrollTop + s.pinTop - s.line;
}

/** Where the tail comes to rest: content end just above the footer's fade. */
export function bottomTarget(s: ScrollSnapshot): number | null {
  const o = tailOvershoot(s);
  return o == null ? null : s.scrollTop + o;
}

/** Holding a specific element still: move by however far it drifted. */
function anchorCorrection(s: ScrollSnapshot): number | null {
  if (s.anchorNow == null) return null;
  const drift = s.anchorNow - s.anchorWas;
  return Math.abs(drift) >= MIN_CORRECTION_PX ? s.scrollTop + drift : null;
}

/**
 * Beyond this fraction of the visible height, a correction under `tail` is eased
 * rather than snapped.
 *
 * Following a write head is a stream of tiny moves — a line at a time, four times
 * a second — and easing those would smear text that should simply appear. But a
 * table, an image, or a mermaid diagram resolving all land at once, and snapping
 * a third of a screen reads as the page being yanked. One threshold, two
 * behaviours, chosen by how much actually moved rather than by what moved.
 */
const EASE_ABOVE_FRACTION = 1 / 8;

/** One pass of the state machine. */
export function planScroll(s: ScrollSnapshot): ScrollPlan {
  const nextSpacer = spacerHeight(s);
  const spacerH = nextSpacer != null && nextSpacer !== s.spacerH ? nextSpacer : null;
  const rest = atRest(s);
  const visible = endVisible(s);

  let owner = s.owner;
  let target: number | null = null;
  let motion: ScrollMotion = "instant";

  // `tail` is meaningless without a turn in flight — or a chat still assembling
  // itself, which is the same problem wearing a different hat. Standing down here
  // rather than in the caller keeps the rule in one place, and makes the plan
  // honest: the owner it reports is the owner it actually acted as.
  if (owner === "tail" && !s.streaming && !s.restoring) owner = "reader";
  // …and it resumes on its own the moment a turn starts while the reader is resting
  // at the end. Resting, not merely "the end is visible" — see `atRest`.
  if (owner === "reader" && s.streaming && rest && !s.readerActive) owner = "tail";

  if (owner === "interaction") {
    // A deliberate toggle outranks everything. The control the reader pressed is
    // held to the pixel while its panel grows or collapses, which is the one thing
    // that made opening a spoiler at the end of the transcript yank it downward:
    // `tail` saw the added height and dutifully chased the new bottom.
    target = anchorCorrection(s);
  } else if (owner === "pin") {
    target = pinTarget(s);
    // Handoff. A spacer of zero means the reply now fills the screen on its own, so
    // the question reached the top by content growing rather than by being held
    // there — and at this instant the two positions coincide, so the owner changes
    // with no visible movement whatsoever.
    if (nextSpacer === 0 && target != null && Math.abs(target - s.scrollTop) < HANDOFF_SLACK_PX) {
      owner = "tail";
      target = bottomTarget(s);
    }
  } else if (owner === "tail") {
    target = bottomTarget(s);
    if (target != null && Math.abs(target - s.scrollTop) > s.height * EASE_ABOVE_FRACTION) motion = "ease";
  } else {
    target = anchorCorrection(s);
  }

  // The reader physically driving outranks every owner, including `interaction`.
  // Note this is applied after the owner logic, so a handoff or a stand-down still
  // resolves mid-gesture — we simply don't act on it until they let go.
  if (s.readerActive) target = null;
  // An eased scroll of ours already owns the position; corrections retarget it
  // rather than fighting it (the caller redirects `animTo`).
  if (s.animating && owner !== "tail" && owner !== "pin") target = null;
  if (target != null && Math.abs(target - s.scrollTop) < MIN_CORRECTION_PX) target = null;

  return { spacerH, owner, target, motion: target == null ? "none" : motion, endVisible: visible, atRest: rest };
}

/**
 * Frame-rate-independent exponential approach: how far to move this frame to cover
 * `remaining` with a `tau` millisecond time constant.
 *
 * Exponential rather than a spring, deliberately. A spring overshoots, and text
 * overshooting its own tail while the model is still writing into it reads as a bug
 * rather than as polish. This is monotonic: it never passes the target.
 */
export function easeStep(remaining: number, dtMs: number, tauMs: number): number {
  return remaining * (1 - Math.exp(-dtMs / tauMs));
}
