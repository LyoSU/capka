import { useCallback, useRef } from "react";

/**
 * Touch long-press detection. Web reveals per-message actions on hover; phones
 * have no hover, so a press-and-hold stands in. Fires once after `ms` unless the
 * finger moves (a scroll) or lifts first. Returns handlers to spread onto the
 * pressable element; it also suppresses the OS callout so our gesture wins.
 */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(
    (e: React.TouchEvent) => {
      clear();
      const t = e.touches[0];
      origin.current = t ? { x: t.clientX, y: t.clientY } : null;
      timer.current = setTimeout(onLongPress, ms);
    },
    [clear, ms, onLongPress],
  );

  // Only a real drag (a scroll) cancels the press. A finger held "still" still
  // emits sub-pixel touchmove on every device, so cancelling on ANY movement
  // means the press almost never survives to fire — allow a 10px slop first.
  const move = useCallback(
    (e: React.TouchEvent) => {
      const o = origin.current;
      const t = e.touches[0];
      if (!o || !t) return;
      if (Math.abs(t.clientX - o.x) > 10 || Math.abs(t.clientY - o.y) > 10) clear();
    },
    [clear],
  );

  return {
    onTouchStart: start,
    onTouchEnd: clear,
    onTouchMove: move,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}
