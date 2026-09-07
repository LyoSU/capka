import { tool } from "ai";
import { z } from "zod";

const DESCRIPTION = `Report that this unattended check found nothing worth telling the owner about, and end the run quietly.

You are running on a schedule with nobody watching. The owner asked to hear from this automation ONLY when there is something that deserves their attention — a change, something new, something that needs a decision. A message that says "I looked and everything is the same" is exactly the noise they asked you to stop sending.

Call this when the check ran fine and found nothing new, nothing changed, and nothing actionable. Do NOT call it when you did find something, when the check itself failed or could not run, or when you are unsure — in those cases just write the reply normally, and the owner will be told.`;

/** What the model gets back from a `nothing_to_report` call. It has already
 *  decided; the only thing left to steer is how much it writes afterwards, since
 *  a quiet run's text is still persisted to the transcript. */
export const QUIET_ACK =
  "Noted. End your reply now with one short sentence at most; do not repeat what you checked.";

/** The turn's own paragraph about running unattended. Lives with the tool it
 *  describes, and is emitted ONLY when the tool is offered — an instruction
 *  naming a tool the model does not have is worse than neither. */
export const QUIET_PROMPT = `## Unattended check
This run was started by an automation, with nobody watching. Its owner asked to be told only when there is something worth their attention. Do the work as instructed; if the result is nothing new, nothing changed and nothing to decide, call \`nothing_to_report\` with a one-line reason instead of writing a reply about it. If you DID find something, or the check itself failed, answer normally — that is what they want to hear about.`;

/** The one flag a quiet run carries, mutated by the tool's `execute` and read by
 *  the runner at finalize. A plain object rather than a return value because the
 *  decision happens deep inside the AI SDK's tool loop, which hands the runner
 *  nothing but the model's parts. */
export type QuietState = { reason?: string };

/**
 * The `nothing_to_report` tool, offered ONLY to an automation run whose owner
 * chose "tell me only when there is something to say".
 *
 * The gate lives here, next to the tool, so the tool set and the prompt
 * paragraph are decided by one expression and can never be offered apart: the
 * caller spreads whatever this returns and asks the SAME object whether to add
 * `QUIET_PROMPT`. An empty set spreads to nothing.
 *
 * Unlike `ask` (no execute — the SDK loop stops and the runner suspends the
 * turn), this one DOES execute: the run must finish normally, because the whole
 * point is a turn that ends without disturbing anyone.
 */
export function makeQuietTool(
  payload: { automationId?: string; notifyMode?: string },
  state: QuietState,
) {
  if (!payload.automationId || payload.notifyMode !== "when_needed") return {};
  return {
    nothing_to_report: tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        reason: z
          .string()
          .max(300, "Keep the reason under 300 characters.")
          .describe("One plain line saying what you checked and why it needs no attention. The owner sees this."),
      }),
      execute: async ({ reason }: { reason: string }) => {
        state.reason = reason;
        return QUIET_ACK;
      },
    }),
  };
}
