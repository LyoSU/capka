import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";

const READABLE_KEYS = ["platform_name", "telegram_bot_token"];
const WRITABLE_KEYS = ["platform_name", "telegram_bot_token"];
const BLOCKED_KEYS = ["auth_secret", "setup_complete", "admin_email"];

export async function GET(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  if (!key) return Response.json({ error: "Missing key" }, { status: 400 });

  if (BLOCKED_KEYS.includes(key) || !READABLE_KEYS.includes(key)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const value = await getSetting(key);
  return Response.json({ key, value });
}

export async function PUT(req: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { key, value, encrypted } = await req.json();
  if (!key || value === undefined) {
    return Response.json({ error: "Missing key or value" }, { status: 400 });
  }

  if (BLOCKED_KEYS.includes(key) || !WRITABLE_KEYS.includes(key)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  await setSetting(key, value, encrypted ?? false);
  return Response.json({ ok: true });
}
