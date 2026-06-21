import { useCallback, useRef } from "react";

/**
 * Touch long-press detection. Web reveals per-message actions on hover; phones
 * have no hover, so a press-and-hold stands in. Fires once after `ms` unless the
 * finger moves (a scroll) or lifts first. Returns handlers to spread onto the
 * pressable element; it also suppresses the OS callout so our gesture wins.
 */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const start = useCallback(() => {
    clear();
    timer.current = setTimeout(onLongPress, ms);
  }, [clear, ms, onLongPress]);

  return {
    onTouchStart: start,
    onTouchEnd: clear,
    onTouchMove: clear,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}
