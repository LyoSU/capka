import { z } from "zod";
import { apiHandler, requireActive } from "@/lib/auth";
import { previewManageForUser } from "@/lib/manage/authed";

const bodySchema = z.object({
  input: z.object({
    action: z.string(),
    target: z.string().optional(),
    value: z.string().optional(),
    itemId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * The before→after preview for a `manage` tool call awaiting approval — the same
 * rich data the old confirm card showed (current value, impact warning, or a
 * connector's live tool-count probe), now fetched by the approval card from the
 * suspended call's input. Resolved AS the signed-in user (their role/locale); may
 * probe the network (reach a connector), so it POSTs. `null` when the input isn't
 * a gated change or the user can't access the target.
 */
export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const { input } = bodySchema.parse(await req.json());
  return Response.json({ preview: await previewManageForUser(userId, input) });
});
