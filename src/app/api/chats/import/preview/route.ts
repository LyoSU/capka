import { z } from "zod";
import { requireRole, apiHandler } from "@/lib/auth";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { detectShareLink, previewSharedChat } from "@/lib/import";
import { isShareImportEnabled } from "@/lib/import/flag";

const schema = z.object({ url: z.string() });

/**
 * Fetch + parse a shared conversation and return a capped preview — WITHOUT
 * writing anything. The client shows the source, title, message count and any
 * "attachments weren't imported" note, then calls /commit to actually create the
 * chat. Rendering happens in the sandbox (`previewSharedChat`); failures surface
 * as an `ImportError` whose `code` the client localizes.
 */
export const POST = apiHandler(async (req: Request) => {
  if (!isShareImportEnabled()) throw new NotFoundError();
  const { userId } = await requireRole("admin", "user");
  const { url } = schema.parse(await req.json());

  const link = detectShareLink(url);
  if (!link) throw new ValidationError("Unsupported share link");

  const result = await previewSharedChat(link, userId);
  return Response.json(result);
});
