import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { getRegistrationMode, getEmailSignupEnabled, isSetupComplete } from "@/lib/settings";
import { emailSignupAllowed, isReservedTelegramEmail } from "@/lib/auth/telegram-oidc";

export async function GET(request: Request) {
  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.GET(request);
}

export async function POST(request: Request) {
  // Email sign-up is governed by the registration mode ("closed" blocks it) AND
  // the standalone email toggle — an admin can forbid email account creation
  // while leaving Telegram open. emailSignupAllowed composes both with the
  // bootstrap exception: before setup is complete self-signup must work so the
  // first admin can create their account.
  const url = new URL(request.url);
  if (url.pathname.endsWith("/sign-up/email")) {
    const [setupDone, mode, emailEnabled] = await Promise.all([
      isSetupComplete(),
      getRegistrationMode(),
      getEmailSignupEnabled(),
    ]);
    if (!emailSignupAllowed({ mode, emailEnabled, setupDone })) {
      return Response.json({ error: "Registration is disabled" }, { status: 403 });
    }
    // Reserve the synthetic Telegram domain: nobody may register an
    // @telegram.local address, which would otherwise let an attacker pre-seed
    // the predictable placeholder email of a Telegram user (account-takeover
    // vector). Read via clone() so the original body still reaches the handler.
    const email = await request
      .clone()
      .json()
      .then((b: { email?: string }) => b?.email ?? "")
      .catch(() => "");
    if (email && isReservedTelegramEmail(email)) {
      return Response.json({ error: "This email address is not allowed" }, { status: 400 });
    }
  }

  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.POST(request);
}
