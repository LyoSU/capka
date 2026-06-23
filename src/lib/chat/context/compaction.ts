import type { StoredPart } from "@/lib/chat/contracts";

/**
 * A normalized message on the active path, ready for context shaping. A node
 * carrying a `compaction` marker IS a checkpoint: a summary that stands in for
 * everything before it. (See toCtxMessages, which derives these from DB rows.)
 */
export interface CtxMessage {
  id: string;
  role: string;
  parts?: StoredPart[];
  /** Present only on a compaction checkpoint node. */
  compaction?: { summary: string; summarizedUpTo: string };
}

/** Heading prefixed to a checkpoint's summary so the model reads it as recap,
 *  not as the user's own words. */
export const SUMMARY_HEADING = "[Summary of the earlier conversation]";

/**
 * Collapse the history at the newest compaction checkpoint: everything up to and
 * including that checkpoint becomes a single summary message, and the messages
 * after it (the fresh tail) follow unchanged. With no checkpoint the input is
 * returned untouched.
 *
 * Positional, not id-based: the checkpoint sits after the turns it summarized, so
 * slicing at its index is what trims them — `summarizedUpTo` is kept on the node
 * only for validation/UI. Several checkpoints fold naturally: we take the LAST
 * one, so an older checkpoint lands inside the summarized zone and its recap is
 * already subsumed by the newer summary.
 */
export function applyCompaction(messages: CtxMessage[]): CtxMessage[] {
  let lastCheckpoint = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].compaction) lastCheckpoint = i;
  }
  if (lastCheckpoint === -1) return messages;

  const cp = messages[lastCheckpoint];
  const summaryMessage: CtxMessage = {
    id: cp.id,
    role: "user",
    parts: [{ type: "text", text: `${SUMMARY_HEADING}\n${cp.compaction!.summary}` }],
  };
  return [summaryMessage, ...messages.slice(lastCheckpoint + 1)];
}
