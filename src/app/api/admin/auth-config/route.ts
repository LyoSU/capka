import { z } from "zod";
import { requireAdmin, apiHandler, resetAuth, telegramRedirectUri } from "@/lib/auth";
import { getSetting, setSetting, getTelegramOidcConfig, getRegistrationMode } from "@/lib/settings";
import { getPublicUrl } from "@/lib/url";

/**
 * Admin config for "Login with Telegram". The client secret is write-only —
 * never echoed back; the UI shows only whether one is stored. The redirect URI
 * is derived from the request origin so the admin can copy it straight into
 * BotFather → Web Login → Allowed URLs.
 */
export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();
  const tg = await getTelegramOidcConfig();
  const mode = await getRegistrationMode();
  const toggle = (await getSetting("telegram_login_enabled")) === "true";
  return Response.json({
    telegram: {
      enabledToggle: toggle,
      ready: tg.enabled,
      clientId: tg.clientId ?? "",
      hasClientSecret: !!tg.clientSecret,
      redirectUri: telegramRedirectUri(getPublicUrl({ headers: req.headers })),
    },
    registrationMode: mode,
  });
});

const bodySchema = z.object({
  clientId: z.string().trim().max(200).optional(),
  // Empty string = "leave the stored secret unchanged"; a value replaces it.
  clientSecret: z.string().optional(),
  enabled: z.boolean().optional(),
  registrationMode: z.enum(["open", "approval", "closed"]).optional(),
});

export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const body = bodySchema.parse(await req.json());

  if (body.clientId !== undefined) await setSetting("telegram_oidc_client_id", body.clientId, false);
  if (body.clientSecret) await setSetting("telegram_oidc_client_secret", body.clientSecret, true);
  if (body.enabled !== undefined) await setSetting("telegram_login_enabled", body.enabled ? "true" : "false", false);
  if (body.registrationMode !== undefined) await setSetting("telegram_registration_mode", body.registrationMode, false);

  // The better-auth instance caches its plugin config — drop it so the next
  // request rebuilds with the new credentials/toggle.
  resetAuth();
  return Response.json({ ok: true });
});
