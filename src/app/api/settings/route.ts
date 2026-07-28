import { requireAdmin, apiHandler } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";

import { READABLE_KEYS, WRITABLE_KEYS, BLOCKED_KEYS } from "./keys";

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

  // The org agent instructions are the one free-text key here, and they go into
  // EVERY request's system prompt — so an accidental paste of a whole document
  // would be billed on every turn for every user. Same cap a project's own
  // instructions get (see projects/schema.ts).
  // Rejects a non-string too: `value` is untyped from the body, and an object here
  // would skip a length check and be serialized into the text column anyway — a
  // 50KB blob in every user's cached prefix, on every turn.
  if (key === "agent_instructions" && (typeof value !== "string" || value.length > 20000)) {
    return Response.json({ error: "Too long" }, { status: 400 });
  }

  const ENCRYPT_KEYS = ["telegram_bot_token"];
  await setSetting(key, value, ENCRYPT_KEYS.includes(key) || (encrypted ?? false));
  return Response.json({ ok: true });
});
