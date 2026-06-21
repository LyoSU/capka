import { getRegistrationMode, isSetupComplete, getTelegramOidcConfig } from "@/lib/settings";

export async function GET() {
  // Mirror the gate in /api/auth/[...all]: closed by default once set up, but
  // open before setup so the first admin can register.
  const setupDone = await isSetupComplete();
  const enabled = !setupDone || (await getRegistrationMode()) !== "closed";
  // Whether the "Sign in with Telegram" button should appear (admin-configured
  // and fully credentialed). Public, non-secret — just a boolean.
  const telegram = await getTelegramOidcConfig();
  return Response.json({ enabled, telegram: { enabled: telegram.enabled } });
}
