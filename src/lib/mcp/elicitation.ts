import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { pendingElicitations } from "@/lib/db/schema";
import { publishTaskEvent } from "@/lib/tasks/events";
import { elicitSchemaToForm, answerToElicitResult } from "@/lib/ask/elicit-map";
import type { AskAnswer } from "@/lib/ask/types";
import { log } from "@/lib/log";

const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 500;

/**
 * Build the MCP elicitation request handler for a run. Elicitation arrives mid
 * `callTool` over a live connection, so — unlike the durable `ask` suspend — it
 * can't snapshot/resume: we surface the same question card, then BLOCK the handler
 * and poll a DB row the user's answer writes to (see answerElicitationForUser).
 * Bounded by a timeout well under MAX_TASK_MS; the stall watchdog is already paused
 * during a tool call, so this quiet block isn't mistaken for a hung provider. On
 * timeout we return `cancel` and the MCP server's tool call fails gracefully.
 */
export function makeElicitHandler(ctx: { userId: string; chatId: string; messageId: string; timeoutMs?: number; origin?: import("@/lib/tasks/delivery").TaskOrigin }) {
  return async (request: { params: { message?: string; requestedSchema?: unknown } }) => {
    const form = elicitSchemaToForm(request.params.requestedSchema, request.params.message);
    const id = nanoid();
    await db.insert(pendingElicitations).values({
      id, chatId: ctx.chatId, messageId: ctx.messageId, userId: ctx.userId, form,
    });
    try {
      // Surface the same card the `ask` tool uses. An `elicit:<id>` toolCallId marks
      // this as a block-and-poll elicitation (no persisted tool-call part) so the
      // client posts the answer with kind:"elicitation".
      await publishTaskEvent(ctx.userId, {
        type: "task:ask", taskId: "", chatId: ctx.chatId, messageId: ctx.messageId,
        toolCallId: `elicit:${id}`, form,
      });
      // On a non-web channel (Telegram) also start the sequential collection there;
      // its answer writes this same row (kind:"elicitation"), which the poll picks up.
      if (ctx.origin?.platform === "telegram") {
        const { getBot } = await import("@/lib/telegram/bot");
        const bot = await getBot();
        if (bot) {
          const { startAskCollection } = await import("@/lib/telegram/ask-collect");
          await startAskCollection(bot, ctx.origin.telegramChatId, {
            userId: ctx.userId, messageId: ctx.messageId, form, kind: "elicitation", locale: ctx.origin.locale,
          });
        }
      }
      const deadline = Date.now() + (ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const [row] = await db.select({ answer: pendingElicitations.answer })
          .from(pendingElicitations).where(eq(pendingElicitations.id, id)).limit(1);
        if (row?.answer) return answerToElicitResult(row.answer as AskAnswer);
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      log.info("elicitation timed out", { chatId: ctx.chatId, id });
      return { action: "cancel" as const };
    } finally {
      await db.delete(pendingElicitations).where(eq(pendingElicitations.id, id)).catch(() => {});
    }
  };
}
