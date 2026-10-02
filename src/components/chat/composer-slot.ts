/**
 * What the composer's one primary slot (far right) shows. Messengers swap record
 * and send in a single place: nothing to send -> record, something to send ->
 * send. Kept pure so the precedence is stated once and tested.
 *
 * - `dictate-stop`: dictation is running. Wins over everything, so interim text
 *   landing in the box cannot flip the slot to send mid-recording.
 * - `stop`: a reply is streaming and there is nothing to send (Stop).
 * - `send`: something to send, or no microphone to offer (then disabled-looking
 *   send, as before).
 * - `mic`: nothing to send, dictation is available and the composer is open.
 */
export type ComposerSlot = "mic" | "send" | "stop" | "dictate-stop";

export function composerSlot(o: {
  /** Typed text or a ready attachment: what Send and Stop already key on. */
  hasContent: boolean;
  /** Any attachment staged at all, even one still uploading or failed. */
  hasStaged: boolean;
  isRunning: boolean;
  isDictating: boolean;
  dictationSupported: boolean;
  /** A card above is awaiting the user; the composer is blocked. */
  awaitingInput?: boolean;
}): ComposerSlot {
  if (o.isDictating) return "dictate-stop";
  if (o.isRunning && !o.hasContent) return "stop";
  if (!o.hasContent && !o.hasStaged && o.dictationSupported && !o.awaitingInput) return "mic";
  return "send";
}
