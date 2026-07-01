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
    .enum(["capabilities", "list", "get", "set", "undo", "add", "remove", "enable", "disable", "debug", "connect"])
    .describe("What to do. Start with `list` or `capabilities` to discover what can be managed."),
  target: z
    .string()
    .optional()
    .describe('A setting/control id (get/set) OR a collection id (get/add/remove/…), e.g. "user.locale", "org.sandbox_network", "mcp".'),
  value: z.string().optional().describe("New value for `set`, always as a string (e.g. \"uk\", \"true\", \"bridge\", \"200000\")."),
  itemId: z.string().optional().describe("Id of a collection item for remove/enable/disable/debug/connect."),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Fields for `add` to a collection, e.g. for mcp: {name, url, authKind:"oauth"} or {name, command, args}.'),
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
    case "add":
      return a.target && a.args ? { action: "add", target: a.target, args: a.args, confirmToken: a.confirmToken } : null;
    case "remove":
      return a.target && a.itemId
        ? { action: "remove", target: a.target, itemId: a.itemId, confirmToken: a.confirmToken }
        : null;
    case "enable":
      return a.target && a.itemId ? { action: "enable", target: a.target, itemId: a.itemId } : null;
    case "disable":
      return a.target && a.itemId ? { action: "disable", target: a.target, itemId: a.itemId } : null;
    case "debug":
      return a.target && a.itemId ? { action: "debug", target: a.target, itemId: a.itemId } : null;
    case "connect":
      return a.target && a.itemId ? { action: "connect", target: a.target, itemId: a.itemId } : null;
  }
}

const DESCRIPTION = `Manage the user's own preferences, platform-wide configuration (admins), AND connectors (MCP) — all through chat.

Settings/controls:
- action="list" (or "capabilities") discovers what THIS user may manage. Never invent an id.
- action="get" reads a control; action="set" changes it (value is always a string).
- Risky org-wide changes are two-phase: the first "set" returns status="confirm_required" with a before→after preview and a confirmToken. Show the preview, ask the user to confirm, then call "set" again with the SAME target/value plus that confirmToken. Never confirm on their behalf. After a change you get an undoToken (action="undo").

Collections (target="mcp" for connectors, target="skill" for agent skills):
- action="get" with a collection target lists its items; add/remove/enable/disable/debug/connect operate on them (itemId identifies one).
- add args for mcp: {name, url, authKind:"oauth"} (remote) or {name, command, args} (local/stdio). add args for skill: {content} where content is a full SKILL.md (frontmatter name+description, then the instruction body). add/remove are confirm-gated like risky settings.
- Some connectors need the user to sign in via a browser (OAuth). action="add" or action="connect" then returns status="action_required" with a URL — DON'T try to open it yourself; tell the user to use the button/link, then re-check with action="debug".
- action="debug" reports a connector's live state (ok / needs login / unreachable) and a hint. NEVER ask the user to paste API keys or tokens into chat — a connector needing a secret token is configured on the settings page, not here.

Role enforcement is server-side: a non-admin can't touch org settings or add shared/local connectors, so don't promise changes you can't make.`;

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
