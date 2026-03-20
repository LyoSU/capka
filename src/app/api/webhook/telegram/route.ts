import { getWebhookHandler } from "@/lib/telegram/bot";
import { getSetting } from "@/lib/settings";

export async function POST(req: Request) {
  // Verify webhook secret from Telegram
  const secret = await getSetting("telegram_webhook_secret");
  if (!secret) return new Response("Webhook not configured", { status: 503 });
  const headerSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (headerSecret !== secret) return new Response("Forbidden", { status: 403 });

  const handler = await getWebhookHandler();
  if (!handler) return new Response("Bot not configured", { status: 503 });

  try {
    return await handler(req);
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return new Response("OK", { status: 200 });
  }
}
