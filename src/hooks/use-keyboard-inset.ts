import { useEffect } from "react";

/** Name of the variable the inset is published as. Read via `publishedKeyboardInset`. */
const KB_VAR = "--kb";

/**
 * Portion of the layout viewport hidden behind the on-screen keyboard.
 *
 * `offsetTop` is load-bearing: it is the visual viewport's own offset within the
 * layout viewport, which iOS Safari changes when it pans the view around a focused
 * field. Omitting it makes the inset read too large by exactly that pan, and
 * anything shifting content by the difference over-lifts by the same amount.
 */
export function keyboardInset(vv: VisualViewport, innerHeight: number): number {
  const raw = innerHeight - vv.height - vv.offsetTop;
  // Snap tiny values to 0 — sub-pixel jitter from the scroll listener would
  // otherwise nudge the composer while idle.
  return raw > 24 ? Math.round(raw) : 0;
}

/**
 * The inset the app has currently published — the ONE number the composer's
 * padding, the scroll area's bottom reserve and the scroll engine all work from.
 *
 * Consumers must read this rather than recomputing from `visualViewport`. A second
 * copy of the formula is not a duplication risk in theory, it is one in practice:
 * the scroll engine carried one that omitted `offsetTop` and the 24px snap, so on
 * iOS it lifted the transcript by a different amount than the padding reserved for
 * — which is a shift with nothing underneath it.
 *
 * Reads the inline style, not the computed one: this is the same property the
 * publisher below sets, so there is nothing to resolve and no layout to flush.
 */
export function publishedKeyboardInset(): number {
  return parseFloat(document.documentElement.style.getPropertyValue(KB_VAR)) || 0;
}

/**
 * Publishes the on-screen keyboard's height as a `--kb` CSS variable on <html>,
 * so bottom-pinned UI (the chat composer) can lift above it.
 *
 * Android Chrome shrinks the layout viewport for the keyboard (we ask for that
 * with `interactive-widget=resizes-content`), so there `innerHeight` already
 * tracks it and `--kb` stays ~0 — no double counting. iOS overlays the keyboard
 * without resizing layout, so we read the gap from `visualViewport` and expose
 * it here. Mount once, app-wide.
 */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return;

    const update = () => {
      root.style.setProperty(KB_VAR, `${keyboardInset(vv, window.innerHeight)}px`);
    };

    update();
    vv.addEventListener("resize", update);
    // `scroll`, not just `resize`: panning the visual viewport over a focused
    // field changes `offsetTop` without changing its height, and that moves the
    // inset without firing a resize.
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty(KB_VAR);
    };
  }, []);
}
