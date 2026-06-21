import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { getRegistrationMode, isSetupComplete } from "@/lib/settings";
import { isReservedTelegramEmail } from "@/lib/auth/telegram-oidc";

export async function GET(request: Request) {
  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.GET(request);
}

export async function POST(request: Request) {
  // Registration is governed by the single instance-wide mode (open/approval/
  // closed) — see getRegistrationMode. "closed" blocks email sign-up entirely.
  // Exception: before setup is complete, self-signup must work so the first
  // admin can bootstrap their account.
  const url = new URL(request.url);
  if (url.pathname.endsWith("/sign-up/email")) {
    const setupDone = await isSetupComplete();
    if (setupDone && (await getRegistrationMode()) === "closed") {
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
