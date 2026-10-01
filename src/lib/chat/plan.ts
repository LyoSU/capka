import { z } from "zod";

/** The live checklist a turn can show above its answer while it works.
 *
 *  Nothing is stored for it beyond the tool call itself: every `update_plan` call
 *  carries the WHOLE list, so the plan at any moment is just the input of the
 *  latest call in the message's parts — on the web, in a reloaded transcript and
 *  in the Telegram draft alike. A turn that never calls it shows nothing. */
export const PLAN_TOOL = "update_plan";

export const planSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80).describe("A short plain phrase in the user's language, e.g. \"Read the spreadsheet\"."),
        status: z.enum(["done", "current", "pending"]),
      }),
    )
    .min(2)
    .max(8),
});

export type PlanStep = z.infer<typeof planSchema>["steps"][number];

type PartLike = { type: string; toolName?: string; name?: string; input?: unknown };

/** The plan as of the latest valid `update_plan` call in `parts`, or null. A call
 *  whose input is still streaming (or malformed) is skipped, so the previous plan
 *  stays up instead of flickering away. Once the turn is over (`running` false) a
 *  step left "current" is shown as done: the model finished the turn, it only
 *  forgot to tick the box — but a "pending" one stays pending, since nothing says
 *  it was ever done. */
export function latestPlan(parts: readonly PartLike[], running: boolean): PlanStep[] | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    const name = p.type === "dynamic-tool" || p.type === "tool-call" ? (p.toolName ?? p.name) : p.type.startsWith("tool-") ? p.type.slice(5) : undefined;
    if (name !== PLAN_TOOL) continue;
    const parsed = planSchema.safeParse(p.input);
    if (!parsed.success) continue;
    return running ? parsed.data.steps : parsed.data.steps.map((s) => (s.status === "current" ? { ...s, status: "done" } : s));
  }
  return null;
}

const MARK = { done: "✓", current: "⟳", pending: "○" } as const;

/** The plan as plain lines, for a channel without the web's checklist (Telegram). */
export function planLines(steps: readonly PlanStep[]): string {
  return steps.map((s) => `${MARK[s.status]} ${s.title}`).join("\n");
}
