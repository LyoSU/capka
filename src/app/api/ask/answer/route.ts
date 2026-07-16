import { z } from "zod";
import { apiHandler, requireActive } from "@/lib/auth";
import { answerAskForUser, answerElicitationForUser } from "@/lib/ask/authed";
import { guardRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

const bodySchema = z.object({
  messageId: z.string().min(1),
  toolCallId: z.string().optional(),
  action: z.enum(["submit", "skip"]),
  values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  // "elicitation" routes to the block-and-poll row writer; default "ask".
  kind: z.enum(["ask", "elicitation"]).default("ask"),
});

/** Resolve the user's answer to a suspended `ask` call (or a blocked MCP
 *  elicitation). Session-authorized — the model can't forge it. */
export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const limited = guardRateLimit(
    `ask-answer:${userId}`,
    RATE_LIMITS.askAnswer,
    "Too many answers — please wait before trying again.",
  );
  if (limited) return limited;
  const d = bodySchema.parse(await req.json());
  const ok = d.kind === "elicitation"
    ? await answerElicitationForUser(userId, d)
    : await answerAskForUser(userId, d);
  return Response.json({ ok });
});
