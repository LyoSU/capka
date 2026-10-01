import { tool } from "ai";

import { PLAN_TOOL, planSchema } from "./plan";

const DESCRIPTION = `Show the user a short checklist of the work in this turn, and keep it current while you work.

Use it ONLY for a task with several distinct steps (roughly three or more tool-using steps, e.g. read a file, analyse it, build a chart, write the report). Never for a question you can just answer or a one-step task.

Call it once before you start, with the first step "current" and the rest "pending"; call it again each time a step finishes. Pass the WHOLE list every time. 3-6 steps, each a short phrase a non-technical person understands, in the user's language — no tool names, commands or file paths. You may reword, add or drop steps as the work changes. Before your final answer, mark every step you did "done" and drop any you skipped.`;

export function makePlanTool() {
  return {
    [PLAN_TOOL]: tool({
      description: DESCRIPTION,
      inputSchema: planSchema,
      execute: async () => "Shown to the user.",
    }),
  };
}
