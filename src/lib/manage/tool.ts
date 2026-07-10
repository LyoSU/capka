import { tool, jsonSchema } from "ai";
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
  /** The model ref this turn runs on — inherited by a created automation. */
  model?: string | null;
}

const ACTIONS = [
  "capabilities", "list", "get", "set", "add", "remove", "enable", "disable", "debug", "connect", "edit",
] as const;

type ManageArgs = {
  action: (typeof ACTIONS)[number];
  target?: string;
  value?: string;
  itemId?: string;
  args?: Record<string, unknown>;
};

// Hand-written JSON Schema, NOT derived from Zod. The AI SDK's Zod→JSONSchema
// path (draft-07) collapses ANY open-object Zod construct — `z.record(z.unknown())`,
// `z.any()`, `.passthrough()`, `looseObject` — to `additionalProperties: false`,
// which forbids the model from sending a single `args` key (repo/content/path,
// name/url, …) and makes every collection `add` impossible. The raw `jsonSchema`
// helper passes through `asSchema` verbatim, so leaving `args.additionalProperties`
// absent keeps it OPEN. Runtime field-shape validation isn't lost: `toInput` maps
// the envelope and each collection's `addSchema`/control `schema` validates the
// payload in `dispatch` with a better (usage-echoing) error than the SDK's generic
// one. (See the tool-schema regression test, and mcp/adapt.ts for the same escape hatch.)
const inputSchema = jsonSchema<ManageArgs>({
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description: "What to do. Start with `list` or `capabilities` to discover what can be managed.",
    },
    target: {
      type: "string",
      description: 'A setting/control id (get/set) OR a collection id (get/add/remove/…), e.g. "user.locale", "org.sandbox_network", "mcp".',
    },
    value: {
      type: "string",
      description: 'New value for `set`, always as a string (e.g. "uk", "true", "bridge", "200000").',
    },
    itemId: {
      type: "string",
      description: "Id of a collection item for remove/enable/disable/debug/connect.",
    },
    args: {
      type: "object",
      description: "Fields for `add` to a collection — the exact shape is documented in that collection's `usage` (returned by get; e.g. mcp: {name, url}).",
    },
  },
  required: ["action"],
  additionalProperties: false,
});

/** Map the flat tool args to a discriminated ManageInput (or null if a required
 *  field for the action is missing). Exported so the approval-preview endpoint can
 *  turn a suspended tool call's persisted input back into a dispatchable action. */
export function toManageInput(a: {
  action: string; target?: string; value?: string; itemId?: string; args?: Record<string, unknown>;
}): ManageInput | null {
  return toInput(a as ManageArgs);
}

/** Which fields each action requires — echoed back on a malformed call so the
 *  model repairs it in one step instead of re-guessing against a generic error. */
const REQUIRED_FIELDS: Record<string, string> = {
  get: "`target`",
  set: "`target` and `value`",
  add: "`target` and `args`",
  remove: "`target` and `itemId`",
  enable: "`target` and `itemId`",
  disable: "`target` and `itemId`",
  debug: "`target` and `itemId`",
  connect: "`target` and `itemId`",
  edit: "`target` and `itemId`",
};

function toInput(a: ManageArgs): ManageInput | null {
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
      // Only `target` is structurally required here. Missing/misplaced `args`
      // (e.g. the model put the payload in `value`, a `set`-only field) flows on
      // with `{}` so `dispatch.add` fails the collection's `addSchema` and echoes
      // its `usage` — a one-step repair — instead of dead-ending on a generic
      // "needs target and args" with no shape hint.
      return a.target ? { action: "add", target: a.target, args: a.args ?? {} } : null;
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
    default:
      // The model-facing schema is hand-written JSON (no Zod enum validation at
      // the SDK boundary), so an unknown action reaches here at runtime; the
      // caller turns null into the friendly `bad_request`.
      return null;
  }
}

const DESCRIPTION = `Manage the user's own preferences, platform-wide configuration (admins), AND connectors (MCP) — all through chat.

Permission is decided by the SERVER from each action's result — not by you reading a role/scope. Everything list/capabilities returns is already available to THIS user, so never refuse up front, never say "you're only a regular user / ask an admin", and never quote internal keys (org.*) to the user. To do something, just call the action and react to the result; only an error result (forbidden/not_found/apply_failed) means it can't happen.

Settings/controls:
- action="list" (or "capabilities") discovers what THIS user may manage. Never invent an id.
- action="get" reads a control; action="set" changes it (value is always a string).
- Risky/platform-wide changes are approved by the USER, not you — this is handled automatically. When you call such a "set", the tool call PAUSES: the user sees an Approve/Reject card and the app blocks until they decide. You don't stage or re-send anything. If they approve, the tool then runs and returns the applied result — continue naturally from there (e.g. confirm it's done). If they reject, you'll get a denial result — acknowledge it and move on. NEVER tell the user to "press Confirm / click the button" (the card speaks for itself), never say you lack permission, and never re-call "set" to retry a pending approval. Undo is a button on the applied card, not something you trigger.

Collections (target="mcp" for connectors, target="skill" for agent skills, target="automations" for scheduled agent runs):
- action="get" with a collection target lists its items AND returns that collection's \`usage\` — the exact add args and workflows. Get the collection BEFORE your first add/edit to it (an add with wrong args also returns the usage). add/remove/enable/disable/debug/connect operate on items (itemId identifies one).
- Each collection in a list/get result carries a resolved \`canAdd\` boolean — that, and ONLY that, tells you whether you may add there; trust it over any inference (e.g. a toggle like "members can install connectors" governs OTHER end-users, never you-as-caller).
- add/remove AND enable PAUSE for the user's approval exactly like a risky setting (enabling a connector/skill/automation activates third-party code or unattended spend, so it needs the same click); after they approve, the action runs and returns its result, and if they reject you get a denial — you never apply it yourself. disable/debug/connect run directly.
- status="action_required" carries a URL only the USER can open (e.g. an OAuth sign-in) — DON'T open it yourself; tell the user to use the button/link, then re-check with action="debug".

Permission and info are different things. Permission is server-side — just attempt the action; never infer what YOU can do from a setting's value (a toggle like "members can install connectors" restricts other end-users, not you-as-caller). If you're only missing INPUT to act — most often a connector's url (remote) or command (local) — ask the user for exactly that in one plain question, and never dress a missing url up as a permissions/admin problem.`;

export function makeManageTool(identity: ManageIdentity) {
  const ctx = (): ManageContext => ({
    userId: identity.userId,
    isAdmin: identity.isAdmin,
    projectId: identity.projectId,
    sessionKey: identity.sessionKey,
    locale: identity.locale,
    model: identity.model,
  });
  // Exactly-once execution per tool call within this task. The runner re-streams
  // the SAME model messages on a capability/stall retry (see makeStream); for an
  // APPROVED-then-executing tool call that means the AI SDK runs `execute` AGAIN
  // with the SAME toolCallId — which, for a mutation like `add`, silently applied
  // it twice (the "created twice" bug). Memoizing the in-flight/settled result by
  // toolCallId collapses that: a re-run returns the first outcome instead of
  // re-applying. A toolCallId is unique per model invocation, so this never merges
  // two genuinely different calls. A rejection is NOT cached — a transient failure
  // must stay retryable.
  const inflight = new Map<string, Promise<ManageResult>>();
  return {
    manage: tool({
      description: DESCRIPTION,
      inputSchema,
      // Native human-in-the-loop: a risky change SUSPENDS the tool call (the SDK
      // emits a tool-approval-request; the user approves/rejects on a card) instead
      // of `execute` staging a pending row. `requiresApproval` is the single source
      // of the confirm policy (org-wide/risky/install/enable → gated unless
      // autonomous, and enabling third-party code / unattended spend stays gated
      // even then). Read-only actions (list/get/capabilities/debug/connect/edit),
      // `disable` (turning something OFF is safety-positive), and personal changes
      // in autonomous mode need none, so they run straight through.
      needsApproval: async (args): Promise<boolean> => {
        const input = toInput(args);
        return input ? requiresApproval(registry, ctx(), input) : false;
      },
      execute: async (args, { toolCallId }): Promise<ManageResult> => {
        const existing = inflight.get(toolCallId);
        if (existing) return existing;
        const run = (async (): Promise<ManageResult> => {
          const input = toInput(args);
          if (!input) {
            return {
              status: "error",
              render: "error",
              code: "bad_request",
              summary: `action="${args.action}" needs ${REQUIRED_FIELDS[args.action] ?? "more fields"} — re-call with them set.`,
            };
          }
          return dispatch(registry, ctx(), input);
        })();
        inflight.set(toolCallId, run);
        // Drop a rejected run so a legitimate retry can re-attempt (dispatch itself
        // returns error RESULTS rather than throwing, so this is the rare throw).
        run.catch(() => inflight.delete(toolCallId));
        return run;
      },
    }),
  };
}
