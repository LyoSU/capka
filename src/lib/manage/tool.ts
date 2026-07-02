import { tool } from "ai";
import { z } from "zod";
import { buildRegistry } from "./controls";
import { dispatch, requiresApproval } from "./dispatch";
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

/** Map the flat tool args to a discriminated ManageInput (or null if a required
 *  field for the action is missing). Exported so the approval-preview endpoint can
 *  turn a suspended tool call's persisted input back into a dispatchable action. */
export function toManageInput(a: {
  action: string; target?: string; value?: string; itemId?: string; args?: Record<string, unknown>;
}): ManageInput | null {
  return toInput(a as z.infer<typeof inputSchema>);
}

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
- Risky/platform-wide changes are approved by the USER, not you — this is handled automatically. When you call such a "set", the tool call PAUSES: the user sees an Approve/Reject card and the app blocks until they decide. You don't stage or re-send anything. If they approve, the tool then runs and returns the applied result — continue naturally from there (e.g. confirm it's done). If they reject, you'll get a denial result — acknowledge it and move on. NEVER tell the user to "press Confirm / click the button" (the card speaks for itself), never say you lack permission, and never re-call "set" to retry a pending approval. Undo is a button on the applied card, not something you trigger.

Collections (target="mcp" for connectors, target="skill" for agent skills, target="automations" for scheduled agent runs):
- add args for mcp: {name, url, authKind:"oauth"} (remote) or {name, command, args} (local/stdio). add args for skill: {content} (a single full SKILL.md — frontmatter name+description then the instruction body), OR {repo} to install EVERY skill from a GitHub skills repo at once (e.g. {repo:"owner/repo"} or a github.com URL), OR {path} to install from the WORKSPACE — a SKILL.md, a skill folder, a repo-shaped folder, or a .zip the user dropped in (the server reads the files itself, so PREFER {path} over pasting file contents into {content}). add {only:["name",...]} narrows a repo/path/zip to specific skills. To CHANGE an existing skill, call action="edit" (target="skill", itemId): it checks the skill out into the workspace and returns the path — edit the files there with your normal file tools (a small partial edit, NOT re-authoring the whole SKILL.md), then save with add {path}. add args for automations: {title, prompt, cron, timezone} for a recurring schedule, or {title, prompt, once_at} for a one-off — title and prompt are ALWAYS required (title is a short label the user sees in the automations list, prompt is the FULL instruction the agent will run each time, written as if starting a fresh conversation). Never omit title. add/remove PAUSE for the user's approval exactly like a risky setting: the approval card lists everything that will be installed; after they approve, the add/remove runs and returns its result (continue from there), and if they reject you get a denial — you never apply it yourself.
- action="get" with a collection target lists its items; add/remove/enable/disable/debug/connect operate on them (itemId identifies one). Each collection in a list/get result carries a resolved \`canAdd\` boolean — that, and ONLY that, tells you whether you may add there; trust it over any inference (e.g. a toggle like "members can install connectors" governs OTHER end-users, never you-as-caller). Adding a personal connector (name+url) or a personal skill needs no admin at all.
- Some connectors need the user to sign in via a browser (OAuth). action="add" or action="connect" then returns status="action_required" with a URL — DON'T try to open it yourself; tell the user to use the button/link, then re-check with action="debug".
- action="debug" reports a connector's live state (ok / needs login / unreachable) and a hint. NEVER ask the user to paste API keys or tokens into chat — a connector needing a secret token is configured on the settings page, not here.

Permission and info are different things. Permission is server-side — just attempt the action; never infer what YOU can do from a setting's value (a toggle like "members can install connectors" restricts other end-users, not you-as-caller). If you're only missing INPUT to act — most often a connector's url (remote) or command (local) — ask the user for exactly that in one plain question, and never dress a missing url up as a permissions/admin problem.`;

export function makeManageTool(identity: ManageIdentity) {
  const ctx = (): ManageContext => ({
    userId: identity.userId,
    isAdmin: identity.isAdmin,
    projectId: identity.projectId,
    sessionKey: identity.sessionKey,
    locale: identity.locale,
  });
  return {
    manage: tool({
      description: DESCRIPTION,
      inputSchema,
      // Native human-in-the-loop: a risky change SUSPENDS the tool call (the SDK
      // emits a tool-approval-request; the user approves/rejects on a card) instead
      // of `execute` staging a pending row. `requiresApproval` is the single source
      // of the confirm policy (org-wide/risky/install → gated unless autonomous).
      // Read-only actions (list/get/capabilities/enable/disable/debug/connect/edit)
      // and personal changes in autonomous mode need none, so they run straight
      // through — same reach as before.
      needsApproval: async (args): Promise<boolean> => {
        const input = toInput(args);
        return input ? requiresApproval(registry, ctx(), input) : false;
      },
      execute: async (args): Promise<ManageResult> => {
        const input = toInput(args);
        if (!input) {
          return { status: "error", render: "error", code: "bad_request", summary: "Missing required fields for this action." };
        }
        return dispatch(registry, ctx(), input);
      },
    }),
  };
}
