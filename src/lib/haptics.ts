// Tiny tactile feedback for touch devices. `navigator.vibrate` is a no-op on
// desktop and unsupported on iOS Safari, so every call is guarded — it's a
// progressive enhancement that simply does nothing where unavailable.
type HapticPattern = "tap" | "success" | "error";

const PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 8, // a light, single confirmation (send, copy)
  success: [10, 36, 16], // a short two-beat "done"
  error: [28, 40, 28],
};

export function haptic(pattern: HapticPattern = "tap"): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(PATTERNS[pattern]);
  } catch {
    /* some browsers throw if called outside a user gesture — ignore */
  }
}
