/**
 * The image viewer's transform, as arithmetic over plain numbers.
 *
 * `ImageViewer` reads the DOM and writes a CSS transform; everything it DECIDES
 * lives here. The split follows `scroll-plan.ts`, and for the same reason: the
 * interesting behaviour is geometry, and none of it is testable while tangled
 * with `getBoundingClientRect` (our suites run `environment: "node"`).
 *
 * ONE OPERATION, NOT FOUR. Zooming with the wheel, pinching with two fingers,
 * dragging, and pressing +/- all reduce to the same question: the image point
 * currently under `from` must end up under `to`, at some new scale.
 * `applyGesture` answers exactly that, so a pan is just the case where the scale
 * is unchanged and a pinch the case where `from`/`to` are the midpoint between
 * two fingers. Every caller therefore lands on the same bounds check — which is
 * what the previous implementation lacked, having a zoom path that clamped the
 * scale and a pan path that clamped nothing at all, so the picture could be
 * dragged clean out of the window.
 *
 * COORDINATES. `x`/`y` are the CSS `translate` in device pixels, and every `Point`
 * here is measured from the CENTRE of the frame, because that is where the
 * transform's origin sits (the image is flex-centred, and `transform-origin`
 * defaults to the element's middle). Feeding in a top-left-based point is the one
 * way to make all of this silently wrong.
 */

export type Point = { x: number; y: number };
export type View = { scale: number; x: number; y: number };

/** The two boxes and the one intrinsic size the transform depends on. */
export type Geometry = {
  /** The <img>'s laid-out, untransformed size — i.e. its fitted size. */
  image: { w: number; h: number };
  /** The clipping frame's padding box: how much of the image can be on screen. */
  frame: { w: number; h: number };
  /** The file's own pixel width, so 1:1 stays reachable for large images. */
  naturalWidth: number;
};

/** Fitted-to-the-window is the floor: there is no "smaller than fits". */
export const MIN_SCALE = 1;

/** The ceiling for an image that already fits, and the floor for it otherwise. */
export const FLOOR_MAX_SCALE = 8;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * How far in this image is allowed to go.
 *
 * A flat cap is wrong for the exact picture someone opens a viewer for: a 5000px
 * screenshot fitted into a 900px pane needs 5.6x before a single one of its pixels
 * is shown at its own size, and one pane size further makes reading the small
 * print in it impossible. So the ceiling is whichever is greater — the generous
 * default, or 1:1 with the file.
 */
export function maxScale(g: Geometry): number {
  const oneToOne = g.image.w > 0 ? g.naturalWidth / g.image.w : 1;
  return Number.isFinite(oneToOne) ? Math.max(FLOOR_MAX_SCALE, oneToOne) : FLOOR_MAX_SCALE;
}

/**
 * The furthest the image may be nudged from centre before its own edge comes
 * inside the frame, i.e. before panning starts revealing emptiness.
 *
 * Zero on an axis where the scaled image still fits, which is what pins a fitted
 * image to the middle instead of letting it be dragged off into a corner.
 */
export function panBounds(g: Geometry, scale: number): Point {
  return {
    x: Math.max(0, (g.image.w * scale - g.frame.w) / 2),
    y: Math.max(0, (g.image.h * scale - g.frame.h) / 2),
  };
}

/**
 * Move the image point currently under `from` so it sits under `to`, at `wanted`
 * scale, and keep the result inside the frame.
 *
 * Anchored, not centred: the centred version is a few lines shorter and feels
 * wrong for the same reason a map would — the thing you aimed at slides away from
 * you while you zoom.
 */
export function applyGesture(v: View, g: Geometry, wanted: number, from: Point, to: Point): View {
  const scale = clamp(wanted, MIN_SCALE, maxScale(g));
  // Back at fit: drop the pan too, so leaving zoom always lands on the tidy
  // centred view rather than on a fitted image nudged off to one side.
  if (scale === MIN_SCALE) return { scale, x: 0, y: 0 };
  // Where `from` falls in the image's own coordinates, so it can be put back
  // under `to` once the scale has changed.
  const px = (from.x - v.x) / v.scale;
  const py = (from.y - v.y) / v.scale;
  const bounds = panBounds(g, scale);
  return {
    scale,
    x: clamp(to.x - px * scale, -bounds.x, bounds.x),
    y: clamp(to.y - py * scale, -bounds.y, bounds.y),
  };
}

/**
 * One detent of a mouse wheel, as an exponent: e^0.223 = 1.25x per notch.
 *
 * It doubles as the per-event ceiling, and that is what makes a notch mean the
 * same thing everywhere. Browsers disagree wildly about how to describe one:
 * Chrome and Safari report ~100 DOM_DELTA_PIXEL, Firefox reports 1
 * DOM_DELTA_LINE, and a Windows touchpad in page mode reports 1 DOM_DELTA_PAGE.
 * Normalising to pixels and then capping at one notch collapses all three onto
 * the same step, while leaving a trackpad's small sub-notch deltas untouched.
 */
const NOTCH = Math.log(1.25);

/** Zoom per pixel of wheel travel. A notch is whatever distance reaches `NOTCH`. */
const WHEEL_RATE = 0.005;

/**
 * A trackpad pinch arrives as a ctrl-wheel carrying a much smaller delta for the
 * same intent, so each pixel of it is worth proportionally more. In the region of
 * the `pow(2, -delta * 0.01)` that Figma, tldraw and Excalidraw all use.
 */
const PINCH_RATE = 0.02;

const PIXELS_PER_LINE = NOTCH / WHEEL_RATE;
const PIXELS_PER_PAGE = 400;

/**
 * The scale multiplier for one wheel event.
 *
 * EXPONENTIAL IN THE DISTANCE TRAVELLED, not a fixed step per event — this is the
 * whole bug the previous version had. Reading only the SIGN of `deltaY` measures
 * how finely a device chops a gesture into events rather than how far the hand
 * moved: a mouse notch is one event and behaved fine, while a trackpad emits
 * dozens per second, so a gentle two-finger flick multiplied by 1.15 forty times
 * over and slammed into the ceiling in a fraction of a second.
 *
 * `exp(a) * exp(b) === exp(a + b)`, so the total zoom now depends only on the
 * total distance scrolled, however the events are chunked. The same identity
 * makes the gesture exactly reversible — scrolling back the way you came returns
 * the original scale, which a naive `x1.15` / `x0.87` pair does not.
 *
 * `ctrlKey` is the browser lying on purpose: a trackpad pinch is delivered as a
 * ctrl-wheel, a convention Chrome took from IE and Firefox later matched. Safari
 * on macOS is the exception and needs `GestureEvent` instead — see the viewer.
 * `metaKey` catches Cmd-scroll, which Mac users reach for by habit.
 *
 * A purely horizontal swipe is now a factor of 1. It used to fall through to the
 * "not negative" branch and zoom OUT, so brushing sideways shrank the picture.
 */
export function wheelZoomFactor(e: {
  deltaY: number;
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  // Browsers deliver shift-wheel on the horizontal axis, so a mouse-wheel user
  // holding shift reports no deltaY at all. Read their intent off the other axis
  // rather than doing nothing.
  const delta = e.deltaY === 0 && e.shiftKey ? (e.deltaX ?? 0) : e.deltaY;
  const unit = e.deltaMode === 1 ? PIXELS_PER_LINE : e.deltaMode === 2 ? PIXELS_PER_PAGE : 1;
  const rate = e.ctrlKey || e.metaKey ? PINCH_RATE : WHEEL_RATE;
  return Math.exp(clamp(-delta * unit * rate, -NOTCH, NOTCH));
}

// What separates a page turn from a hesitant nudge or the start of something
// else. The distance is a fraction of the pane rather than a pixel count, so the
// gesture asks for the same proportion of the screen on a phone and on a
// desktop. The flick is the escape hatch for the short, fast swipe that never
// travels far enough to satisfy the first rule.
const SWIPE_TRAVEL = 0.25;
const SWIPE_FLICK_SPEED = 0.5;
const SWIPE_FLICK_TRAVEL = 40;

// How far horizontal must beat vertical before a drag counts as sideways at all.
const SWIPE_AXIS_BIAS = 1.2;

/**
 * Which way a finished one-finger drag across a fitted image should page: -1 for
 * the previous file, +1 for the next, 0 to snap back.
 *
 * Only meaningful at fit. Once the image is larger than the frame the same drag
 * is a pan, and there is a real thing under the finger to move.
 *
 * The axis test is what keeps this from firing on a mis-grab: a drag that is
 * mostly vertical is someone reaching for something else, and paging away from
 * the picture they were looking at is the one outcome that cannot be undone by
 * simply not letting go.
 */
export function swipeVerdict(d: { dx: number; dy: number; elapsedMs: number; width: number }): -1 | 0 | 1 {
  if (d.width <= 0) return 0;
  if (Math.abs(d.dx) < Math.abs(d.dy) * SWIPE_AXIS_BIAS) return 0;
  const travelled = Math.abs(d.dx) >= d.width * SWIPE_TRAVEL;
  const flicked =
    d.elapsedMs > 0 &&
    Math.abs(d.dx) >= SWIPE_FLICK_TRAVEL &&
    Math.abs(d.dx) / d.elapsedMs >= SWIPE_FLICK_SPEED;
  if (!travelled && !flicked) return 0;
  // Dragging left pulls the next file in from the right, the way a stack of
  // photos moves rather than the way a scrollbar does.
  return d.dx < 0 ? 1 : -1;
}
