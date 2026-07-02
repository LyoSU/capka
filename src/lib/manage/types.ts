import type { z } from "zod";
import type { PendingStore } from "./pending";

/** Where a control lives, and thus who may touch it. `user` = the caller's own
 *  preference (any authenticated user, their own row). `org` = a shared,
 *  platform-wide setting (admin only). `project` = scoped to one project. */
export type Scope = "user" | "project" | "org";
export type Role = "user" | "admin";
/** `safe` applies immediately (trivial personal prefs); `confirm` is two-phase —
 *  the agent must surface a preview and re-call with a confirm token. */
export type Risk = "safe" | "confirm";

/** Everything a control handler needs about the caller. Injected by the runner
 *  from the run's identity — NEVER derived from the model's arguments, so the
 *  agent cannot claim a role it doesn't have. `audit` is injectable for tests. */
export interface ManageContext {
  userId: string;
  isAdmin: boolean;
  projectId: string | null;
  /** The active sandbox session key (`projectId ?? chatId`) — lets collections
   *  read workspace files server-side (e.g. ingest a skill from a dropped file or
   *  archive) without round-tripping bytes through the model. Undefined off-turn. */
  sessionKey?: string;
  /** The user's locale — all user-facing strings are resolved to it server-side
   *  (default English). Undefined → English. */
  locale?: string;
  /** Store for staged confirmations. Injected in tests; production falls back to
   *  the DB-backed store (lazy-imported), like `audit`. */
  pending?: PendingStore;
  audit?: (e: { action: string; targetType?: string; targetKey?: string; detail?: Record<string, unknown> }) => Promise<void> | void;
}

/** A single manageable thing. Its value is always a string — settings are stored
 *  as strings, which keeps undo trivial (the previous string round-trips through
 *  the same schema). Mutation delegates to the existing service layer. */
export interface Control {
  id: string;
  title: string;
  description: string;
  scope: Scope;
  requiredRole: Role;
  risk: Risk;
  schema: z.ZodType<string>;
  /** A fixed set of allowed values, rendered as pickable chips (a `choice` card).
   *  For `z.enum` controls this is derived from the schema automatically; declare
   *  it only when the valid set can't be read off the schema (e.g. a refined
   *  string like `user.locale`). */
  options?: string[];
  read(ctx: ManageContext): Promise<string>;
  /** Human-readable rendering of a raw value (e.g. "true" → "Увімкнено"). */
  format?(value: string): string;
  apply(ctx: ManageContext, value: string): Promise<void>;
  /** Optional warning about knock-on effects, shown in the confirm preview. */
  impact?(ctx: ManageContext, next: string): Promise<string | undefined>;
  /** Applying this control changes server-rendered UI (e.g. `user.locale` switches
   *  the whole interface language), so the web card refreshes the route after
   *  apply/undo instead of leaving stale content until a manual reload. */
  reloadOnApply?: boolean;
  /** Always require the confirm card, even when the org runs in `autonomous` mode
   *  (which otherwise applies risky changes directly). Reserved for the master
   *  switch itself (`org.agent_autonomy`) so a prompt-injected agent can't silently
   *  disable supervision. */
  alwaysConfirm?: boolean;
}

export type ManageInput =
  | { action: "capabilities" }
  | { action: "list" }
  | { action: "get"; target: string }
  // set/add/remove only STAGE a confirmation (risky) or apply directly (safe) —
  // the model can never carry a token to apply a staged change itself.
  | { action: "set"; target: string; value: unknown }
  // Collection actions — target is a collection id (e.g. "mcp").
  | { action: "add"; target: string; args: Record<string, unknown> }
  | { action: "remove"; target: string; itemId: string }
  | { action: "enable"; target: string; itemId: string }
  | { action: "disable"; target: string; itemId: string }
  | { action: "debug"; target: string; itemId: string }
  | { action: "connect"; target: string; itemId: string }
  | { action: "edit"; target: string; itemId: string };

/** One row of a collection (an MCP connector, later a skill/plugin). */
export interface CollectionItem {
  id: string;
  title: string;
  subtitle?: string;
  enabled?: boolean;
  /** A short status word the UI can badge (e.g. "ok", "needs_login"). */
  status?: string;
  /** The requesting user personally owns this item (vs a shared/org one). */
  owned?: boolean;
}

/** A hand-back to the human for something the agent can't do itself (an OAuth
 *  redirect, a folder picker). Rendered as a button in web, a link in Telegram. */
export interface RequiredAction {
  kind: "oauth" | "open_url";
  url: string;
  label: string;
  description?: string;
}

/** A managed collection of items with CRUD + connector-specific ops. `list` is
 *  visible to anyone who can see the collection; `requiredRole` gates mutation
 *  (add/remove/enable). add/remove are always confirm-gated by the dispatcher;
 *  enable/disable/debug/connect apply directly. Register one to add a whole new
 *  manageable resource (MCP today, skills next) without touching the dispatcher. */
export interface Collection {
  id: string;
  title: string;
  description: string;
  requiredRole: Role;
  /** Audit-log noun for this collection's mutations — the trail records
   *  `${auditNoun}.{add,remove,enable,disable}` so a skill change never masquerades
   *  as a connector change. */
  auditNoun: "connector" | "skill" | "automation";
  /** The full settings page that manages this collection, so a chat card can offer
   *  a quiet "Open in settings →" link to the richer UI (the card is a summary). */
  settingsPath?: string;
  /** Keep add confirm-gated even in `autonomous` mode — for collections whose add
   *  runs third-party code (MCP connectors), the one checkpoint injection can't
   *  bypass. Reversible/instruction-only collections (skills) omit it. */
  alwaysConfirm?: boolean;
  addSchema?: z.ZodTypeAny;
  /** Resolved, authoritative "may THIS caller add here" — surfaced to the model
   *  (UI-style, like the settings page's capability endpoint) so it never has to
   *  infer its own permission from an unrelated setting's value. Defaults to the
   *  coarse `requiredRole` check when omitted. */
  canAdd?(ctx: ManageContext): Promise<boolean>;
  list(ctx: ManageContext): Promise<CollectionItem[]>;
  add?(ctx: ManageContext, args: Record<string, unknown>): Promise<{ itemTitle: string; action?: RequiredAction }>;
  /** Cheap pre-flight run BEFORE a confirm card is shown: throws a friendly Error
   *  if this payload could never be added (caller not authorized, or invalid
   *  content), so the dispatcher refuses up front instead of previewing a change
   *  that apply would then reject. */
  validateAdd?(ctx: ManageContext, args: Record<string, unknown>): Promise<void>;
  /** Human summary of what an add would do, for the confirm preview. `details` is
   *  a short human description (e.g. what a skill does); `body` is the full text
   *  the user is approving (e.g. the SKILL.md) shown collapsibly — so nobody
   *  confirms an unseen permanent instruction. */
  previewAdd?(
    ctx: ManageContext,
    args: Record<string, unknown>,
  ):
    | { title: string; after: string; impact?: string; details?: string; body?: string; items?: string[] }
    // May be async so it can PROBE before the confirm card is shown (e.g. try to
    // reach a remote connector and report its tool count, or enumerate the skills a
    // repo would install so the user approves the whole set — `items`).
    | Promise<{ title: string; after: string; impact?: string; details?: string; body?: string; items?: string[] }>;
  remove?(ctx: ManageContext, itemId: string): Promise<{ itemTitle: string }>;
  setEnabled?(ctx: ManageContext, itemId: string, enabled: boolean): Promise<{ itemTitle: string }>;
  debug?(ctx: ManageContext, itemId: string): Promise<{ itemTitle: string; state: string; detail?: string; hint?: string; action?: RequiredAction }>;
  connect?(ctx: ManageContext, itemId: string): Promise<RequiredAction | null>;
  /** Check an item OUT into the workspace for cheap in-place editing: materialize
   *  its files so the agent edits them with its normal file tools (a partial edit,
   *  not re-authoring the whole thing), then saves back via `add {path}`. Returns
   *  the workspace path and a one-line instruction telling the model what to do. */
  edit?(ctx: ManageContext, itemId: string): Promise<{ itemTitle: string; path: string; instruction: string }>;
}

/** A change the UI renders as a SettingChangeCard (before→after diff + Undo).
 *  Strings arrive already localized to the user's locale (resolved server-side),
 *  so the card is a dumb renderer. */
export interface SettingChange {
  controlId: string;
  title: string;
  before: string;
  after: string;
  /** Opaque id of a staged undo — the Undo button/callback consumes it via the
   *  same human-authed path (the model never applies an undo either). */
  undoPendingId?: string;
  /** The control's `reloadOnApply` — tells the card to refresh the route once the
   *  change is applied (or undone), so a locale switch takes effect immediately. */
  reload?: boolean;
}

export type ManageResult =
  | { status: "ok"; render: "setting"; summary: string; data: SettingChange }
  | { status: "ok"; render: "list" | "value" | "capabilities"; summary: string; data?: unknown }
  | {
      status: "ok";
      render: "choice";
      summary: string;
      /** A control whose value is one of a fixed set — the card shows the options
       *  as chips (current one marked). Picking one asks the agent to `set` it, so
       *  the confirm barrier still applies (safe → applied, risky → staged). */
      data: { id: string; title: string; value: string; options: { value: string; label: string }[] };
    }
  | {
      status: "ok";
      render: "collection";
      summary: string;
      data: { collectionId: string; title: string; items: CollectionItem[]; canAdd: boolean; settingsPath?: string };
    }
  | {
      status: "ok";
      render: "resource";
      summary: string;
      data: { op: "added" | "removed" | "enabled" | "disabled" | "editing"; collectionId: string; title: string; itemTitle: string; action?: RequiredAction; settingsPath?: string; path?: string };
    }
  | {
      status: "ok";
      render: "debug";
      summary: string;
      data: { title: string; itemTitle: string; state: string; detail?: string; hint?: string; action?: RequiredAction };
    }
  | { status: "action_required"; render: "action_required"; summary: string; action: RequiredAction }
  | {
      status: "confirm_required";
      render: "confirm";
      summary: string;
      /** Opaque handle to the server-staged change. Safe to expose — applying it
       *  requires the session cookie / Telegram callback, which the model lacks. */
      pendingId: string;
      preview: { controlId: string; title: string; before: string; after: string; impact?: string; details?: string; body?: string; items?: string[] };
    }
  | { status: "error"; render: "error"; summary: string; code: string };
