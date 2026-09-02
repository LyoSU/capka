/**
 * Which step of an entrance cascade a row gets.
 *
 * Rows that mount TOGETHER cascade (opening a finished spoiler, a chat with
 * history); a row that arrives alone onto a rail already on screen must not wait
 * for its position in the list. `mountedBefore` is how many rows the rail held at
 * the previous commit, so anything at or below it is not new and anything above
 * it counts from zero. Capped so a long history still finishes unfolding promptly.
 * The row keeps the value it mounted with — see the `useState` at each call site —
 * because changing a running animation's delay snaps its progress.
 */
export function staggerIndex(index: number, mountedBefore: number, cap = 6): number {
  return Math.min(cap, Math.max(0, index - mountedBefore));
}
