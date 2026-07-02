import { z } from "zod";
import { apiHandler, requireActive } from "@/lib/auth";
import { approveManageForUser } from "@/lib/manage/authed";

const bodySchema = z.object({
  messageId: z.string().min(1),
  toolCallId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().max(500).optional(),
});

/**
 * Resolve the user's decision on a `manage` tool call the AI SDK suspended for
 * native human-in-the-loop approval — the human-controlled half of the boundary.
 * Authorization is the session cookie (which the model cannot forge), so a
 * prompt-injected agent that staged the call can never approve it. Records the
 * decision on the suspended message and enqueues the turn's continuation, which
 * re-runs the tool (approved) or lets the model acknowledge the denial.
 */
export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const d = bodySchema.parse(await req.json());
  const ok = await approveManageForUser(userId, d);
  // 200 even when the pending call is gone (already decided, or expired): the card
  // reconciles to its resolved state — this isn't an HTTP-level failure.
  return Response.json({ ok });
});
