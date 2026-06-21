import { useEffect, useRef } from "react";

/**
 * Lets the device Back button / edge-swipe close a mobile overlay instead of
 * navigating away from the app — the expected gesture for a full-screen sheet.
 *
 * While `active`, a throwaway history entry sits on top of the stack. Pressing
 * Back pops it and we read that as "dismiss". When the overlay is closed by
 * other means (a button, a selection), we remove the entry we added so Back
 * doesn't need an extra press — but only if it's still the current entry, so a
 * real navigation that happened meanwhile is never undone.
 */
export function useBackDismiss(active: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    window.history.pushState({ __overlay: true }, "");
    const onPop = () => closeRef.current();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Our marker is still on top → the overlay closed via the UI, so unwind
      // the entry. If something navigated, the top state isn't ours and we
      // leave history alone.
      if ((window.history.state as { __overlay?: boolean } | null)?.__overlay) {
        window.history.back();
      }
    };
  }, [active]);
}
