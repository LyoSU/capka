import { realtime } from "@/lib/realtime";

/**
 * Every event delivered to a user's realtime channel (`user:<id>`), consumed by
 * the SSE bridge in `useBackgroundChat`. This union is the single contract
 * between publishers (runner, worker, Telegram bot) and the client — publish
 * through `publishTaskEvent` so TypeScript enforces the shape and the literals
 * can never silently drift from what the client switches on.
 */
export type TaskEvent =
  | { type: "task:start"; taskId: string; chatId: string; messageId: string }
  | { type: "task:text-delta"; taskId: string; chatId: string; messageId: string; delta: string }
  | { type: "task:reasoning-delta"; taskId: string; chatId: string; messageId: string; delta: string }
  // Fired the instant the model STARTS emitting a tool call — before its
  // arguments have streamed in. Lets the UI surface the step (a spinner with a
  // generic label) immediately, then refine it once `task:tool-call` carries the
  // parsed args. Purely a liveness affordance: nothing is persisted for it.
  | { type: "task:tool-input-start"; taskId: string; chatId: string; messageId: string; toolCallId: string; toolName: string }
  | { type: "task:tool-call"; taskId: string; chatId: string; messageId: string; toolCallId: string; toolName: string; args: unknown }
  // isError marks a genuine tool failure (the AI SDK tool-error event). The
  // result shape alone can't be trusted — successful tools like read_file return
  // an `error: null` field, which the client must NOT read as a failure.
  | { type: "task:tool-result"; taskId: string; chatId: string; messageId: string; toolCallId: string; result: unknown; isError?: boolean }
  // messageId is absent when a task fails/cancels before an assistant message exists.
  | { type: "task:finish"; taskId: string; chatId: string; messageId?: string; status: string; error?: string }
  // A freshly-generated title for a new chat, pushed once after its first turn
  // so the sidebar can swap the placeholder in place (and animate) without a refetch.
  | { type: "chat:title"; chatId: string; title: string }
  | { type: "new_message"; chatId: string };

/** The per-user realtime channel name. Centralized so it never drifts. */
export function userChannel(userId: string): string {
  return `user:${userId}`;
}

/** Publish a typed event to a user's channel. */
export function publishTaskEvent(userId: string, event: TaskEvent): Promise<void> {
  return realtime.publish(userChannel(userId), event);
}
