/**
 * Folding older messages out of layout and paint — the arithmetic.
 *
 * A long transcript keeps its recent tail fully rendered (it is what the reader is
 * looking at, and what the scroll engine measures against) and turns everything
 * before it into a `content-visibility: auto` placeholder. Two numbers decide that,
 * and both were paid for in a harness: a guessed placeholder height moved the page
 * under a reader scrolling up by whole screens, a border-box measurement left a
 * jolt of exactly padding plus border, and the content-box height left none.
 */

/** How many leading messages may be folded, keeping `recent` rendered at the end. */
export function foldableCount(total: number, recent = 20): number {
  return Math.max(0, total - recent);
}

/** The placeholder height for a folded row: its content box, because
 *  `contain-intrinsic-size` sizes the content box and the padding is still drawn. */
export function placeholderPx(box: { clientHeight: number; paddingTop: number; paddingBottom: number }): number {
  return Math.max(0, box.clientHeight - box.paddingTop - box.paddingBottom);
}
