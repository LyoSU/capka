import {
  getRegistrationMode,
  getEmailSignupEnabled,
  isSetupComplete,
  getTelegramOidcConfig,
} from "@/lib/settings";
import { emailSignupAllowed } from "@/lib/auth/telegram-oidc";

export async function GET() {
  // `enabled` here means "email sign-up is offered". Mirror the gate in
  // /api/auth/[...all] exactly so the register page never shows a form that the
  // server would reject. When email is off but Telegram is on, the register page
  // falls back to the Telegram-only path.
  const [setupDone, mode, emailEnabled, telegram] = await Promise.all([
    isSetupComplete(),
    getRegistrationMode(),
    getEmailSignupEnabled(),
    getTelegramOidcConfig(),
  ]);
  const enabled = emailSignupAllowed({ mode, emailEnabled, setupDone });
  // Whether the "Sign in with Telegram" button should appear (admin-configured
  // and fully credentialed). Public, non-secret — just a boolean.
  return Response.json({ enabled, telegram: { enabled: telegram.enabled } });
}
