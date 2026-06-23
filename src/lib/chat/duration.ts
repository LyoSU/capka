/** Compact, Grok-style duration for the "reasoned for …" labels: "58s" under a
 *  minute, "1m 3s" beyond it. Always latin "s"/"m" so the web transcript and the
 *  Telegram thinking block read identically. */
export function formatShortDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
