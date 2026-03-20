import { getWebhookHandler } from "@/lib/telegram/bot";

export async function POST(req: Request) {
  const handler = await getWebhookHandler();
  if (!handler)
    return new Response("Bot not configured", { status: 503 });
  try {
    return await handler(req);
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return new Response("OK", { status: 200 });
  }
}
