import { tool } from "ai";
import { z } from "zod";
import { rememberFact, forgetFact } from "./store";

export interface MemoryToolCtx {
  userId: string;
  /** Present only for project chats; gates the "project" scope. */
  projectId: string | null;
}

/**
 * Lets the agent deliberately curate its own long-term memory (Letta-style),
 * alongside the passive per-turn reconcile. A fact added here rides the same
 * append path and is tidied by the next consolidation. Scope picks which
 * document it lands in: the user-global doc or this project's doc.
 *
 * Tool DEFINITIONS are constant across runs (cache-stable) — they hold no
 * per-turn state, just the ctx ids.
 */
export function makeMemoryTools(ctx: MemoryToolCtx) {
  const inProject = ctx.projectId != null;
  const scope = z
    .enum(["user", "project"])
    .describe('"user" = remember about the person across all chats; "project" = scoped to this project\'s work')
    .optional();
  // Resolve a scope to the doc it writes: "project" only when actually in one.
  const docFor = (s?: "user" | "project") => (s === "project" && inProject ? ctx.projectId : null);

  return {
    remember: tool({
      description:
        "Save a durable fact, preference, or decision to long-term memory so you recall it in future conversations. " +
        "Use for things worth remembering beyond this chat — not transient task details." +
        (inProject ? "" : " (Only user-global memory is available outside a project.)"),
      inputSchema: z.object({
        fact: z.string().min(1).describe("One concise fact to remember"),
        scope,
      }),
      execute: async ({ fact, scope: s }) => {
        await rememberFact(ctx.userId, docFor(s), fact);
        return { ok: true, remembered: fact, scope: docFor(s) ? "project" : "user" };
      },
    }),
    forget: tool({
      description: "Remove facts from long-term memory that match a phrase (because they're wrong or no longer true).",
      inputSchema: z.object({
        match: z.string().min(1).describe("A distinctive phrase from the fact(s) to remove"),
        scope,
      }),
      execute: async ({ match, scope: s }) => {
        await forgetFact(ctx.userId, docFor(s), match);
        return { ok: true, forgot: match, scope: docFor(s) ? "project" : "user" };
      },
    }),
  };
}
