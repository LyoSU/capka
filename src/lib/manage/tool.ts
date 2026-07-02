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
  /** Active sandbox session key (`projectId ?? chatId`) — lets manage read
   *  workspace files server-side (skill ingest/edit). Undefined off-turn. */
  sessionKey?: string;
  /** The user's locale — all user-facing strings resolve to it (default English). */
  locale?: string;
}

const inputSchema = z.object({
  action: z
    .enum(["capabilities", "list", "get", "set", "add", "remove", "enable", "disable", "debug", "connect", "edit"])
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
      return a.target && a.value !== undefined ? { action: "set", target: a.target, value: a.value } : null;
    case "add":
      return a.target && a.args ? { action: "add", target: a.target, args: a.args } : null;
    case "remove":
      return a.target && a.itemId ? { action: "remove", target: a.target, itemId: a.itemId } : null;
    case "enable":
      return a.target && a.itemId ? { action: "enable", target: a.target, itemId: a.itemId } : null;
    case "disable":
      return a.target && a.itemId ? { action: "disable", target: a.target, itemId: a.itemId } : null;
    case "debug":
      return a.target && a.itemId ? { action: "debug", target: a.target, itemId: a.itemId } : null;
    case "connect":
      return a.target && a.itemId ? { action: "connect", target: a.target, itemId: a.itemId } : null;
    case "edit":
      return a.target && a.itemId ? { action: "edit", target: a.target, itemId: a.itemId } : null;
  }
}

const DESCRIPTION = `Manage the user's own preferences, platform-wide configuration (admins), AND connectors (MCP) — all through chat.

Permission is decided by the SERVER from each action's result — not by you reading a role/scope. Everything list/capabilities returns is already available to THIS user, so never refuse up front, never say "you're only a regular user / ask an admin", and never quote internal keys (org.*) to the user. To do something, just call the action and react to the result; only an error result (forbidden/not_found/apply_failed) means it can't happen.

Settings/controls:
- action="list" (or "capabilities") discovers what THIS user may manage. Never invent an id.
- action="get" reads a control; action="set" changes it (value is always a string).
- Risky org-wide changes are confirmed by the USER, not you: "set" returns status="confirm_required" with a before→after preview. This ALREADY means the user is authorized (the server checked their role) and a confirmation card/button is shown to them. You CANNOT apply it — there is no token to re-send; only the user's click applies it. Do NOT say you lack permission, do NOT re-ask in prose, do NOT try to "set" again. Reply at most one short line, then STOP and wait — the applied change arrives on its own. Undo is a button too, not something you trigger.

Collections (target="mcp" for connectors, target="skill" for agent skills):
- action="get" with a collection target lists its items; add/remove/enable/disable/debug/connect operate on them (itemId identifies one).
- add args for mcp: {name, url, authKind:"oauth"} (remote) or {name, command, args} (local/stdio). add args for skill: {content} (a single full SKILL.md — frontmatter name+description then the instruction body), OR {repo} to install EVERY skill from a GitHub skills repo at once (e.g. {repo:"owner/repo"} or a github.com URL), OR {path} to install from the WORKSPACE — a SKILL.md, a skill folder, a repo-shaped folder, or a .zip the user dropped in (the server reads the files itself, so PREFER {path} over pasting file contents into {content}). add {only:["name",...]} narrows a repo/path/zip to specific skills. To CHANGE an existing skill, call action="edit" (target="skill", itemId): it checks the skill out into the workspace and returns the path — edit the files there with your normal file tools (a small partial edit, NOT re-authoring the whole SKILL.md), then save with add {path}. The confirm card lists all the skills that will be installed. add/remove are confirmed by the user (confirm_required), exactly like risky settings — you stage, the user applies.
- Some connectors need the user to sign in via a browser (OAuth). action="add" or action="connect" then returns status="action_required" with a URL — DON'T try to open it yourself; tell the user to use the button/link, then re-check with action="debug".
- action="debug" reports a connector's live state (ok / needs login / unreachable) and a hint. NEVER ask the user to paste API keys or tokens into chat — a connector needing a secret token is configured on the settings page, not here.

Permission and info are different things. Permission is server-side — just attempt the action; never infer what YOU can do from a setting's value (a toggle like "members can install connectors" restricts other end-users, not you-as-caller). If you're only missing INPUT to act — most often a connector's url (remote) or command (local) — ask the user for exactly that in one plain question, and never dress a missing url up as a permissions/admin problem.`;

export function makeManageTool(identity: ManageIdentity) {
  return {
    manage: tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async (args): Promise<ManageResult> => {
        const input = toInput(args);
        if (!input) {
          return { status: "error", render: "error", code: "bad_request", summary: "Missing required fields for this action." };
        }
        const ctx: ManageContext = {
          userId: identity.userId,
          isAdmin: identity.isAdmin,
          projectId: identity.projectId,
          sessionKey: identity.sessionKey,
          locale: identity.locale,
        };
        return dispatch(registry, ctx, input);
      },
    }),
  };
}
