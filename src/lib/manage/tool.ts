import { tool } from "ai";
import { z } from "zod";
import { buildRegistry } from "./controls";
import { dispatch } from "./dispatch";
import type { ManageContext, ManageInput, ManageResult } from "./types";

/** The registry is stateless (controls delegate to the service layer), so it's
 *  built once per process and shared across runs. */
const registry = buildRegistry();

export interface ManageIdentity {
  userId: string;
  isAdmin: boolean;
  projectId: string | null;
  /** HMAC secret for confirm/undo tokens — the platform master key. */
  secret: string;
}

const inputSchema = z.object({
  action: z
    .enum(["capabilities", "list", "get", "set", "undo"])
    .describe("What to do. Start with `list` or `capabilities` to discover what can be managed."),
  target: z.string().optional().describe('Control id for get/set, e.g. "user.locale" or "org.sandbox_network".'),
  value: z.string().optional().describe("New value for `set`, always as a string (e.g. \"uk\", \"true\", \"bridge\", \"200000\")."),
  confirmToken: z
    .string()
    .optional()
    .describe("Echo the confirmToken from a confirm_required result to APPLY a change the user just confirmed."),
  undoToken: z.string().optional().describe("The undoToken from a prior change, to revert it."),
});

function toInput(a: z.infer<typeof inputSchema>): ManageInput | null {
  switch (a.action) {
    case "capabilities":
      return { action: "capabilities" };
    case "list":
      return { action: "list" };
    case "get":
      return a.target ? { action: "get", target: a.target } : null;
    case "set":
      return a.target && a.value !== undefined
        ? { action: "set", target: a.target, value: a.value, confirmToken: a.confirmToken }
        : null;
    case "undo":
      return a.undoToken ? { action: "undo", undoToken: a.undoToken } : null;
  }
}

const DESCRIPTION = `Manage the user's own preferences AND (for admins) platform-wide configuration, all through chat.

Flow:
- Use action="list" (or "capabilities") to discover what you may manage for THIS user. You only ever see controls allowed for their role — never invent a control id.
- action="get" reads one control; action="set" changes it (value is always a string).
- Risky org-wide changes are two-phase: the first "set" returns status="confirm_required" with a human preview (before → after) and a confirmToken. Show the user the preview, ask them to confirm, and only then call "set" again with the SAME target/value plus that confirmToken. Never confirm on the user's behalf.
- After any change you get an undoToken — offer to undo if the user regrets it (action="undo").
Role enforcement is server-side: a non-admin simply cannot touch org settings, so don't promise changes you can't make.`;

export function makeManageTool(identity: ManageIdentity) {
  return {
    manage: tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async (args): Promise<ManageResult> => {
        const input = toInput(args);
        if (!input) {
          return { status: "error", render: "error", code: "bad_request", summary: "Бракує обов'язкових полів для цієї дії." };
        }
        const ctx: ManageContext = {
          userId: identity.userId,
          isAdmin: identity.isAdmin,
          projectId: identity.projectId,
          secret: identity.secret,
        };
        return dispatch(registry, ctx, input);
      },
    }),
  };
}
