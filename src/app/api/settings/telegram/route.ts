import { Bot } from "grammy";
import { requireAdmin, requireSession, apiHandler } from "@/lib/auth";
import { setSetting, isSetupComplete } from "@/lib/settings";
import { restartBot } from "@/lib/telegram/bot";

export const POST = apiHandler(async (req: Request) => {
  // After setup, this is an admin-only action. DURING setup the caller isn't admin
  // yet — but the route stores a bot token and restarts the bot, so it must never
  // run fully unauthenticated. Require at least a signed-in session in the setup
  // window (the bootstrap account); only drop the admin check, not all auth.
  const setupDone = await isSetupComplete();
  if (setupDone) await requireAdmin();
  else await requireSession();

  const { botToken } = await req.json();
  if (!botToken?.trim()) {
    return Response.json({ error: "Missing bot token" }, { status: 400 });
  }

  // Validate token
  let botInfo;
  try {
    const bot = new Bot(botToken.trim());
    botInfo = await bot.api.getMe();
  } catch {
    return Response.json({ error: "Invalid bot token" }, { status: 400 });
  }

  // Save token (encrypted) plus the bot's @username (public, non-secret) so the
  // link UI can render a one-tap deep link for users of any role.
  await setSetting("telegram_bot_token", botToken.trim(), true);
  await setSetting("telegram_bot_username", botInfo.username ?? "", false);

  // Start (or restart) long-polling with the new token — no public webhook
  // URL needed, so this works behind NAT/firewalls out of the box.
  try {
    await restartBot();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({
      ok: true,
      botUsername: botInfo.username,
      warning: `Saved, but couldn't start the bot: ${msg}. Restarting the server will retry.`,
    });
  }

  return Response.json({ ok: true, botUsername: botInfo.username });
});
