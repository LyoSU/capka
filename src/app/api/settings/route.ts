import { requireAdmin, apiHandler } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";

const READABLE_KEYS = ["platform_name", "telegram_bot_token", "model_min_context", "sandbox_enabled", "sandbox_network", "registration_enabled", "block_private_provider_urls", "share_admin_providers"];
const WRITABLE_KEYS = ["platform_name", "telegram_bot_token", "model_min_context", "sandbox_enabled", "sandbox_network", "registration_enabled", "block_private_provider_urls", "share_admin_providers"];
const BLOCKED_KEYS = ["auth_secret", "setup_complete", "admin_email"];

export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  if (!key) return Response.json({ error: "Missing key" }, { status: 400 });

  if (BLOCKED_KEYS.includes(key) || !READABLE_KEYS.includes(key)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const value = await getSetting(key);
  return Response.json({ key, value });
});

export const PUT = apiHandler(async (req: Request) => {
  await requireAdmin();
  const { key, value, encrypted } = await req.json();
  if (!key || value === undefined) {
    return Response.json({ error: "Missing key or value" }, { status: 400 });
  }

  if (BLOCKED_KEYS.includes(key) || !WRITABLE_KEYS.includes(key)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const ENCRYPT_KEYS = ["telegram_bot_token"];
  await setSetting(key, value, ENCRYPT_KEYS.includes(key) || (encrypted ?? false));
  return Response.json({ ok: true });
});
