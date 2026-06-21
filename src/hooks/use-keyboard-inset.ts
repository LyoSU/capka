import { useEffect } from "react";

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
      // Portion of the layout viewport hidden behind the keyboard.
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // Snap tiny values to 0 — sub-pixel jitter from the scroll listener would
      // otherwise nudge the composer while idle.
      root.style.setProperty("--kb", inset > 24 ? `${Math.round(inset)}px` : "0px");
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--kb");
    };
  }, []);
}
