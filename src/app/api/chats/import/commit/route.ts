import { z } from "zod";
import { requireRole, apiHandler } from "@/lib/auth";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { createImportedChat } from "@/lib/chat/tree";
import { normalizeImport, MAX_IMPORT_MESSAGES } from "@/lib/import";
import { isShareImportEnabled } from "@/lib/import/flag";

const schema = z.object({
  source: z.enum(["claude", "chatgpt"]),
  title: z.string().nullable().optional(),
  // The model the user has selected — the imported chat adopts it so their next
  // turn runs on the model they picked here, not a stale default.
  model: z.string().nullable().optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(MAX_IMPORT_MESSAGES),
});

/**
 * Create a new chat from a previewed import. The messages come from the client's
 * preview round-trip; we re-run `normalizeImport` here so the caps and sanitize
 * are enforced server-side regardless — the commit never trusts the client's copy
 * (though the worst a tampered payload could do is put text into the caller's own
 * private chat, which carries no privilege anyway).
 */
export const POST = apiHandler(async (req: Request) => {
  if (!isShareImportEnabled()) throw new NotFoundError();
  const { userId } = await requireRole("admin", "user");
  const body = schema.parse(await req.json());

  const normalized = normalizeImport({
    source: body.source,
    title: body.title ?? null,
    messages: body.messages,
    truncated: false,
    droppedRichContent: false,
  });
  if (normalized.messages.length === 0) throw new ValidationError("Nothing to import");

  const chatId = await createImportedChat({
    userId,
    model: body.model ?? null,
    title: normalized.title,
    messages: normalized.messages,
    importSource: body.source,
  });

  return Response.json({ id: chatId }, { status: 201 });
});
