import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { getSetting } from "@/lib/settings";

export async function GET(request: Request) {
  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.GET(request);
}

export async function POST(request: Request) {
  // Block registration if admin disabled it
  const url = new URL(request.url);
  if (url.pathname.endsWith("/sign-up/email")) {
    const enabled = await getSetting("registration_enabled");
    if (enabled === "false") {
      return Response.json({ error: "Registration is disabled" }, { status: 403 });
    }
  }

  const auth = await getAuth();
  const handler = toNextJsHandler(auth);
  return handler.POST(request);
}
