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
  // Elicitation answers a polled DB row (one boolean outcome); `ask` answers a
  // suspended turn and can also refuse retryably ("busy"). Normalize to the same
  // shape so the card reads one field either way.
  const outcome = d.kind === "elicitation"
    ? ((await answerElicitationForUser(userId, d)) ? "applied" : "gone")
    : await answerAskForUser(userId, d);
  return Response.json({ ok: outcome === "applied", outcome });
});
