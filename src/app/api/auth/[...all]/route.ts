import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { getSetting, isSetupComplete } from "@/lib/settings";

export async function GET(request: Request) {
  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.GET(request);
}

export async function POST(request: Request) {
  // Registration is CLOSED by default: allowed only when an admin explicitly
  // enabled it. Exception: before setup is complete, self-signup must work so
  // the first admin can bootstrap their account.
  const url = new URL(request.url);
  if (url.pathname.endsWith("/sign-up/email")) {
    const setupDone = await isSetupComplete();
    if (setupDone && (await getSetting("registration_enabled")) !== "true") {
      return Response.json({ error: "Registration is disabled" }, { status: 403 });
    }
  }

  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.POST(request);
}
