"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

/**
 * A draggable width for one of the two side columns.
 *
 * The chat is the thing people came for, so the two panels beside it are the
 * ones that give way: the caller supplies a `maxWidth()` that already subtracts
 * whatever the conversation needs, and the applied width is derived from the
 * user's preference through that ceiling rather than stored clamped. That way a
 * window squeezed narrow shrinks the panel, and widening it again gives back
 * exactly the width the user chose instead of the squeezed one.
 */

/** Keyboard step. One arrow press is a visible nudge, not a pixel. */
const STEP = 16;

/**
 * How far past the minimum a drag has to go before it closes the column instead
 * of stopping dead against it.
 *
 * Without this the last stretch of the gesture is a dead zone: the handle stops
 * moving and the pointer keeps going, which reads as the drag having broken. And
 * the intent behind shoving a panel all the way into the edge of the screen is
 * never "make it 14rem" — it is "get this out of my way". So the overshoot is
 * given a meaning rather than swallowed. It is a deliberate 64px, far more than
 * the wobble of a hand that meant to stop at the minimum.
 */
const COLLAPSE_OVERSHOOT = 64;

/** Has this drag gone far enough past the minimum to mean "close it"? Only ever
 *  true for a host that offered a way to close (see `onCollapse`). */
export function shouldCollapse(rawWidth: number, min: number): boolean {
  return rawWidth < min - COLLAPSE_OVERSHOOT;
}

/**
 * Has a drag from a CLOSED edge gone far enough to mean "bring it back"?
 *
 * `dx` is how far the pointer has travelled in the growing direction, not a
 * width: a shut column has no width to drag, only a way back. The threshold is
 * the same overshoot that closed it, so the gesture is its own inverse — the
 * column comes back the way it went, and a drag that closes something the user
 * then cannot drag open is half a gesture.
 */
export function shouldExpand(dx: number): boolean {
  return dx > COLLAPSE_OVERSHOOT;
}

/**
 * Look and interaction of the drag handle, shared by both edges. Positioning is
 * the host's business (one edge is `fixed` beside the sidebar, the other sits
 * inside a clipped panel), so this carries no `position` of its own.
 *
 * The hairline is an `::after` rather than a child element so both hosts can
 * render the handle as a single self-closing div.
 */
export const RESIZE_HANDLE_CLASS =
  "z-20 hidden w-2 cursor-col-resize touch-none select-none md:block " +
  "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent " +
  "after:transition-colors after:duration-150 motion-reduce:after:transition-none " +
  "hover:after:bg-border-strong data-[dragging=true]:after:bg-primary " +
  "focus-visible:outline-none focus-visible:after:bg-primary focus-visible:after:w-0.5";

/** Whole pixels inside [min, max]. A `max` below `min` happens on a narrow
 *  window — the chat's floor wins, so the minimum is the one that survives. */
export function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}

/** The stored width for a column, or `fallback` when there is none, the value is
 *  unusable, or storage itself is unavailable (private window, blocked cookies). */
export function readStoredWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** Remember a width, or forget it (`null`) so the column follows the default. */
export function writeStoredWidth(key: string, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(width)));
  } catch {}
}

export type ResizeHandleProps = {
  role: "separator";
  "aria-orientation": "vertical";
  "aria-label": string;
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
  "data-dragging": "true" | "false";
  tabIndex: 0;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: () => void;
  onDoubleClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
};

export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  maxWidth,
  label,
  direction,
  onCollapse,
}: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  /** The ceiling right now, in px. Re-read on mount, on window resize, and at
   *  the start of every drag — it depends on the viewport and the other column. */
  maxWidth: () => number;
  label: string;
  /** `1` when dragging right widens the column (a left-hand panel), `-1` when it
   *  narrows it (a right-hand panel). */
  direction: 1 | -1;
  /** Shut the column. Supplied by a host that HAS a closed state; a drag shoved
   *  well past the minimum then closes it instead of grinding against the clamp.
   *  Omit it and the minimum is simply the end of the road. */
  onCollapse?: () => void;
}): { width: number; dragging: boolean; handleProps: ResizeHandleProps; reset: () => void } {
  // What the user asked for, before the ceiling. Starts at the default so the
  // server and the first client render agree; the stored value is adopted on mount.
  const [preferred, setPreferred] = useState(defaultWidth);
  const [max, setMax] = useState(() => Math.max(min, defaultWidth));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; from: number } | null>(null);

  // `maxWidth` is a fresh closure every render; a ref keeps the resize listener
  // and the drag handlers on the current one without re-subscribing.
  const maxRef = useRef(maxWidth);
  maxRef.current = maxWidth;

  useEffect(() => {
    setMax(Math.max(min, maxRef.current()));
    setPreferred(readStoredWidth(storageKey, defaultWidth));
  }, [storageKey, defaultWidth, min]);

  useEffect(() => {
    const onResize = () => setMax(Math.max(min, maxRef.current()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min]);

  const width = clampWidth(preferred, min, max);

  const commit = useCallback(
    (next: number) => {
      const w = clampWidth(next, min, max);
      setPreferred(w);
      writeStoredWidth(storageKey, w);
    },
    [min, max, storageKey],
  );

  const reset = useCallback(() => {
    setPreferred(defaultWidth);
    writeStoredWidth(storageKey, null);
  }, [defaultWidth, storageKey]);

  const handleProps: ResizeHandleProps = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": label,
    "aria-valuenow": width,
    "aria-valuemin": min,
    "aria-valuemax": Math.max(min, max),
    "data-dragging": dragging ? "true" : "false",
    tabIndex: 0,
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      // Without this the drag starts by selecting the text it passes over.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setMax(Math.max(min, maxRef.current()));
      drag.current = { x: e.clientX, from: width };
      setDragging(true);
    },
    onPointerMove: (e) => {
      const start = drag.current;
      if (!start) return;
      const raw = start.from + (e.clientX - start.x) * direction;
      if (onCollapse && shouldCollapse(raw, min)) {
        // End the drag here and hand back the width the column had before it.
        // The gesture said "close", not "resize, then close" — so re-opening
        // should give back the width the user chose, not the sliver they shoved
        // it through on the way out. Storage is untouched for the same reason:
        // it still holds that pre-drag width.
        drag.current = null;
        setDragging(false);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        setPreferred(start.from);
        onCollapse();
        return;
      }
      setPreferred(clampWidth(raw, min, max));
    },
    onPointerUp: (e) => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      writeStoredWidth(storageKey, width);
    },
    // A capture lost to a browser gesture must still end the drag, or the handle
    // keeps following the pointer with no button held.
    onLostPointerCapture: () => {
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      writeStoredWidth(storageKey, width);
    },
    onDoubleClick: reset,
    onKeyDown: (e) => {
      if (e.key === "ArrowLeft") commit(width - STEP * direction);
      else if (e.key === "ArrowRight") commit(width + STEP * direction);
      else if (e.key === "Home") commit(min);
      else if (e.key === "End") commit(Math.max(min, max));
      else return;
      e.preventDefault();
    },
  };

  return { width, dragging, handleProps, reset };
}
