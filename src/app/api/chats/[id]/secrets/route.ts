import { requireSession, apiHandler } from "@/lib/auth";
import { chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import {
  listSecretNames,
  setSecret,
  deleteSecret,
  normalizeSecretName,
  isValidSecretValue,
  MAX_SECRET_VALUE_CHARS,
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

async function ownedChat(id: string): Promise<{ userId: string; chatId: string }> {
  const { userId } = await requireSession();
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
  const { userId, chatId } = await ownedChat(id);

  const body = (await req.json()) as { name?: unknown; value?: unknown };
  const rawName = typeof body.name === "string" ? body.name : "";
  const value = typeof body.value === "string" ? body.value : "";

  const name = normalizeSecretName(rawName);
  if (!name) {
    return Response.json({ error: "Invalid name", code: "BAD_NAME" }, { status: 400 });
  }
  if (!isValidSecretValue(value)) {
    return Response.json(
      { error: `Value must be 1..${MAX_SECRET_VALUE_CHARS} characters`, code: "BAD_VALUE" },
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
  const { chatId } = await ownedChat(id);

  const body = (await req.json()) as { name?: unknown };
  const name = normalizeSecretName(typeof body.name === "string" ? body.name : "");
  if (!name) return Response.json({ error: "Invalid name", code: "BAD_NAME" }, { status: 400 });

  await deleteSecret(chatId, name);
  return Response.json({ ok: true });
});
