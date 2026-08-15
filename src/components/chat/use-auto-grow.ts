"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * A textarea that grows to fit its text and then scrolls inside its own cap.
 *
 * The cap comes from the element's own `max-height`, so callers set it in CSS
 * next to the rest of their styling instead of passing a number.
 *
 * Re-measures on width changes, not only on typing. Height depends on how the
 * text wraps, and the width can change with nothing typed at all — an orientation
 * change, the sidebar opening, a web font finishing loading. Without that the box
 * keeps a height computed for a different width, and since these boxes sit inside
 * `overflow-hidden` cards, the surplus line isn't merely hidden: it is sliced
 * through the middle at the card's edge.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value?: unknown) {
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
    // Only scroll once the content really outgrows the cap. Below it the box fits
    // its text exactly, and a fractional line height (15px × 1.625 = 24.375px)
    // rounds `scrollHeight` down to less than the real content — which would
    // otherwise paint a phantom scrollbar in a one-line box.
    const max = parseFloat(getComputedStyle(el).maxHeight);
    el.style.overflowY = Number.isFinite(max) && el.scrollHeight > max ? "auto" : "hidden";
  }, [ref]);

  // Re-measure whenever the caller's value changes — covers programmatic changes
  // (a send clearing the composer, a restored draft) that fire no input event.
  useEffect(() => { resize(); }, [value, resize]);

  const lastWidth = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Observing the element itself is enough: anything that changes how the text
    // wraps changes this box's width. But this callback SETS the height, and a
    // height change is itself a resize — so react to width alone, or the observer
    // feeds itself (Chrome reports that as an undelivered-notifications loop).
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w === lastWidth.current) return;
      lastWidth.current = w;
      resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, resize]);

  return resize;
}
