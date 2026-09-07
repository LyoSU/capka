import { requireSession, requireWriter, apiHandler } from "@/lib/auth";
import { chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import {
  listSecretNames,
  setSecret,
  deleteSecret,
  normalizeSecretName,
  isValidSecretValue,
  MAX_SECRET_VALUE_CHARS,
  MIN_SECRET_VALUE_CHARS,
  MAX_CHAT_SECRETS,
} from "@/lib/chat/secrets";

/**
 * Thread-scoped credentials: names in, names out, values one-way.
 *
 * Every verb re-resolves the chat through `requireOwned`, which 404s a chat that is
 * someone else's exactly as it does one that does not exist — a foreign chat must not be
 * distinguishable from a missing one, or this route enumerates other people's chat ids.
 *
 * There is deliberately no GET for a value. Nothing downstream of `setSecret` reads a
 * plaintext credential back except the sandbox injection, and adding a read path here
 * would be the one hole that makes "the model never sees it" untrue.
 */

/**
 * `gate` is the auth check, not a detail: `requireSession` admits an active VIEWER, which
 * is the right answer for reading names and the wrong one for storing or deleting a
 * credential. A viewer whose role was downgraded after the chat was created still owned
 * the chat, so ownership alone let them write. Mutations pass `requireWriter` — the same
 * admin-or-user gate `/api/chat` uses before it spends the shared key.
 */
async function ownedChat(
  id: string,
  gate: () => Promise<{ userId: string }> = requireSession,
): Promise<{ userId: string; chatId: string }> {
  const { userId } = await gate();
  await requireOwned(chats, id, userId, "Chat");
  return { userId, chatId: id };
}

export const GET = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { chatId } = await ownedChat(id);
  return Response.json({ secrets: await listSecretNames(chatId) });
});

export const POST = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { userId, chatId } = await ownedChat(id, requireWriter);

  const body = (await req.json()) as { name?: unknown; value?: unknown };
  const rawName = typeof body.name === "string" ? body.name : "";
  const value = typeof body.value === "string" ? body.value : "";

  const name = normalizeSecretName(rawName);
  if (!name) {
    return Response.json({ error: "Invalid name", code: "BAD_NAME" }, { status: 400 });
  }
  // Split from the general BAD_VALUE because the person can act on it and the UI says
  // something different: a value this short is one the redactor would skip, so storing it
  // would break the promise printed right above the field.
  if (value.length < MIN_SECRET_VALUE_CHARS) {
    return Response.json(
      { error: `Value must be at least ${MIN_SECRET_VALUE_CHARS} characters`, code: "VALUE_TOO_SHORT", min: MIN_SECRET_VALUE_CHARS },
      { status: 400 },
    );
  }
  if (!isValidSecretValue(value)) {
    return Response.json(
      { error: `Value must be ${MIN_SECRET_VALUE_CHARS}..${MAX_SECRET_VALUE_CHARS} characters`, code: "BAD_VALUE" },
      { status: 400 },
    );
  }

  // The controller refuses an exec carrying more than `MAX_CHAT_SECRETS` variables, so
  // accepting one more here would not add a credential — it would break every command in
  // this chat until someone deleted a row. Checked against the names already stored, and
  // only for a NEW name: rotating an existing credential at the cap must keep working.
  const existing = await listSecretNames(chatId);
  if (existing.length >= MAX_CHAT_SECRETS && !existing.some((s) => s.name === name)) {
    return Response.json(
      { error: `This chat can hold ${MAX_CHAT_SECRETS} secrets`, code: "TOO_MANY", max: MAX_CHAT_SECRETS },
      { status: 400 },
    );
  }

  // Upsert, so this never conflicts: saving a name that already exists is how a user
  // rotates a credential, and answering 409 would make the calm path an error state.
  await setSecret({ chatId, userId, name, value });
  return Response.json({ name });
});

export const DELETE = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { chatId } = await ownedChat(id, requireWriter);

  const body = (await req.json()) as { name?: unknown };
  const name = normalizeSecretName(typeof body.name === "string" ? body.name : "");
  if (!name) return Response.json({ error: "Invalid name", code: "BAD_NAME" }, { status: 400 });

  await deleteSecret(chatId, name);
  return Response.json({ ok: true });
});
