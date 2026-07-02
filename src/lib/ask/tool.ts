import { tool } from "ai";
import { askFormSchema } from "./types";

const DESCRIPTION = `Ask the user a structured question and PAUSE until they answer, then continue this same turn with their reply.

Use this ONLY when you are genuinely blocked on information or a decision that is the user's to make and that you cannot reasonably infer or default. Do NOT use it to chat, to confirm something you could just do, or to offer help. Prefer sensible defaults over asking.

One call can bundle several fields (e.g. a format choice AND a filename). Each field is either free "text" or a "choice" of 2-6 options (set multi:true to allow several). Keep labels short and plain — the user is non-technical. After they answer you receive their values and finish the task; if they skip, proceed gracefully (assume a reasonable default or explain what you'll do instead).`;

/** The `ask` tool: a NO-execute tool. When the model calls it the AI SDK
 *  tool-loop stops the run (there's nothing to feed back), which the runner
 *  turns into a durable "awaiting_answer" suspend — resolved by the user's
 *  answer, which resumes the SAME turn. Contrast `manage`, which suspends via
 *  needsApproval (a boolean); `ask` carries a richer answer, so it uses the
 *  no-execute path instead. */
export function makeAskTool() {
  return {
    ask: tool({
      description: DESCRIPTION,
      inputSchema: askFormSchema,
      // NO execute — intentional. See above.
    }),
  };
}
