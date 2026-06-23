import { realtime } from "@/lib/realtime";

/**
 * Every event delivered to a user's realtime channel (`user:<id>`), consumed by
 * the SSE bridge in `useBackgroundChat`. This union is the single contract
 * between publishers (runner, worker, Telegram bot) and the client — publish
 * through `publishTaskEvent` so TypeScript enforces the shape and the literals
 * can never silently drift from what the client switches on.
 */
// `seq` is a per-message monotonic counter the runner stamps on every event
// that mutates (or finalizes) the assistant reply. It lets a client that
// (re)mounts mid-stream tell whether a delta is already covered by the persisted
// snapshot (`metadata.streamSeq`), is the next contiguous one, or sits past a
// gap — so resumed streams reconcile instead of appending onto a stale prefix
// and showing a truncated reply. Optional: legacy/non-runner publishers
// (Telegram bot, `new_message`) omit it and the client applies them as before.
export type TaskEvent =
  | { type: "task:start"; taskId: string; chatId: string; messageId: string; seq?: number }
  | { type: "task:text-delta"; taskId: string; chatId: string; messageId: string; delta: string; seq?: number }
  | { type: "task:reasoning-delta"; taskId: string; chatId: string; messageId: string; delta: string; seq?: number }
  // Fired the instant the model STARTS emitting a tool call — before its
  // arguments have streamed in. Lets the UI surface the step (a spinner with a
  // generic label) immediately, then refine it once `task:tool-call` carries the
  // parsed args. Purely a liveness affordance: nothing is persisted for it.
  | { type: "task:tool-input-start"; taskId: string; chatId: string; messageId: string; toolCallId: string; toolName: string; seq?: number }
  | { type: "task:tool-call"; taskId: string; chatId: string; messageId: string; toolCallId: string; toolName: string; args: unknown; seq?: number }
  // isError marks a genuine tool failure (the AI SDK tool-error event). The
  // result shape alone can't be trusted — successful tools like read_file return
  // an `error: null` field, which the client must NOT read as a failure.
  | { type: "task:tool-result"; taskId: string; chatId: string; messageId: string; toolCallId: string; result: unknown; isError?: boolean; seq?: number }
  // A retry inside the runner threw away the partial reply (`parts.length = 0`)
  // for a capability/empty-response retry. The client must DISCARD the streamed
  // parts for this message and resync its applied-seq, so retry deltas land on a
  // clean slate instead of being appended to the abandoned attempt.
  | { type: "task:reset"; taskId: string; chatId: string; messageId: string; seq: number }
  // messageId is absent when a task fails/cancels before an assistant message exists.
  | { type: "task:finish"; taskId: string; chatId: string; messageId?: string; status: string; error?: string; seq?: number }
  // A freshly-generated title for a new chat, pushed once after its first turn
  // so the sidebar can swap the placeholder in place (and animate) without a refetch.
  | { type: "chat:title"; chatId: string; title: string }
  // A compaction checkpoint was written — the client reloads so the transcript
  // shows the divider and the context meter re-derives (it hides until the next
  // turn reports the post-compaction size).
  | { type: "chat:compacted"; chatId: string; messageId: string }
  | { type: "new_message"; chatId: string };

/** The per-user realtime channel name. Centralized so it never drifts. */
export function userChannel(userId: string): string {
  return `user:${userId}`;
}

/** Publish a typed event to a user's channel. */
export function publishTaskEvent(userId: string, event: TaskEvent): Promise<void> {
  return realtime.publish(userChannel(userId), event);
}
