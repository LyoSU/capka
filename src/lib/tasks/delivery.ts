/**
 * Where a finished task's result should be delivered, beyond the web UI (which
 * always gets it via realtime + the stored message). Today only Telegram needs
 * an outbound push; the union keeps room for more channels (email, Slack…)
 * without touching the runner. Persisted inside the task payload.
 */
import { log } from "@/lib/log";

export type TaskOrigin = { platform: "telegram"; telegramChatId: number };

export interface TaskResult {
  status: "completed" | "failed" | "cancelled";
  text: string;
  /** Friendly, user-facing error (set when status is "failed"). */
  error?: string;
}

const TELEGRAM_LIMIT = 4000; // under Telegram's 4096 hard cap, with headroom

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

/**
 * Deliver a finished task's result to its origin channel. Best-effort and never
 * throws — a delivery failure must not fail the task (the result is already
 * persisted and shown in the web UI).
 */
export async function deliverTaskResult(origin: TaskOrigin, result: TaskResult): Promise<void> {
  if (result.status === "cancelled") return; // nothing useful to send

  if (origin.platform === "telegram") {
    try {
      const { getBot } = await import("@/lib/telegram/bot");
      const bot = await getBot();
      if (!bot) return;
      const body =
        result.status === "completed"
          ? result.text.trim() || "(the assistant returned no text)"
          : result.error || "Something went wrong. Please try again.";
      // Plain text on purpose: agent output isn't guaranteed valid Telegram
      // Markdown, and a parse error would drop the whole message.
      for (const part of chunk(body, TELEGRAM_LIMIT)) {
        await bot.api.sendMessage(origin.telegramChatId, part);
      }
    } catch (e) {
      log.error("telegram delivery failed", { chatId: origin.telegramChatId, err: String(e) });
    }
  }
}
