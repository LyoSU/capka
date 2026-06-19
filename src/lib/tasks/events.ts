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
  | { type: "task:tool-call"; taskId: string; chatId: string; messageId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "task:tool-result"; taskId: string; chatId: string; messageId: string; toolCallId: string; result: unknown }
  // messageId is absent when a task fails/cancels before an assistant message exists.
  | { type: "task:finish"; taskId: string; chatId: string; messageId?: string; status: string; error?: string }
  | { type: "new_message"; chatId: string };

/** The per-user realtime channel name. Centralized so it never drifts. */
export function userChannel(userId: string): string {
  return `user:${userId}`;
}

/** Publish a typed event to a user's channel. */
export function publishTaskEvent(userId: string, event: TaskEvent): Promise<void> {
  return realtime.publish(userChannel(userId), event);
}
