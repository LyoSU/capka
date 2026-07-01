import type { z } from "zod";

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
 *  agent cannot claim a role it doesn't have. `audit`/`now` are injectable for
 *  tests. */
export interface ManageContext {
  userId: string;
  isAdmin: boolean;
  projectId: string | null;
  /** HMAC secret for confirm/undo tokens (the master key in production). */
  secret: string;
  /** The user's locale — all user-facing strings are resolved to it server-side
   *  (default English). Undefined → English. */
  locale?: string;
  audit?: (e: { action: string; targetType?: string; targetKey?: string; detail?: Record<string, unknown> }) => Promise<void> | void;
  now?: () => number;
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
  read(ctx: ManageContext): Promise<string>;
  /** Human-readable rendering of a raw value (e.g. "true" → "Увімкнено"). */
  format?(value: string): string;
  apply(ctx: ManageContext, value: string): Promise<void>;
  /** Optional warning about knock-on effects, shown in the confirm preview. */
  impact?(ctx: ManageContext, next: string): Promise<string | undefined>;
}

export type ManageInput =
  | { action: "capabilities" }
  | { action: "list" }
  | { action: "get"; target: string }
  | { action: "set"; target: string; value: unknown; confirmToken?: string }
  | { action: "undo"; undoToken: string }
  // Collection actions — target is a collection id (e.g. "mcp").
  | { action: "add"; target: string; args: Record<string, unknown>; confirmToken?: string }
  | { action: "remove"; target: string; itemId: string; confirmToken?: string }
  | { action: "enable"; target: string; itemId: string }
  | { action: "disable"; target: string; itemId: string }
  | { action: "debug"; target: string; itemId: string }
  | { action: "connect"; target: string; itemId: string };

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
  addSchema?: z.ZodTypeAny;
  list(ctx: ManageContext): Promise<CollectionItem[]>;
  add?(ctx: ManageContext, args: Record<string, unknown>): Promise<{ itemTitle: string; action?: RequiredAction }>;
  /** Human summary of what an add would do, for the confirm preview. */
  previewAdd?(ctx: ManageContext, args: Record<string, unknown>): { title: string; after: string; impact?: string };
  remove?(ctx: ManageContext, itemId: string): Promise<{ itemTitle: string }>;
  setEnabled?(ctx: ManageContext, itemId: string, enabled: boolean): Promise<{ itemTitle: string }>;
  debug?(ctx: ManageContext, itemId: string): Promise<{ itemTitle: string; state: string; detail?: string; hint?: string; action?: RequiredAction }>;
  connect?(ctx: ManageContext, itemId: string): Promise<RequiredAction | null>;
}

/** A change the UI renders as a SettingChangeCard (before→after diff + Undo).
 *  Strings arrive already localized to the user's locale (resolved server-side),
 *  so the card is a dumb renderer. */
export interface SettingChange {
  controlId: string;
  title: string;
  before: string;
  after: string;
  undoToken?: string;
}

export type ManageResult =
  | { status: "ok"; render: "setting"; summary: string; data: SettingChange }
  | { status: "ok"; render: "list" | "value" | "capabilities"; summary: string; data?: unknown }
  | {
      status: "ok";
      render: "collection";
      summary: string;
      data: { collectionId: string; title: string; items: CollectionItem[] };
    }
  | {
      status: "ok";
      render: "resource";
      summary: string;
      data: { op: "added" | "removed" | "enabled" | "disabled"; collectionId: string; title: string; itemTitle: string; action?: RequiredAction };
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
      confirmToken: string;
      preview: { controlId: string; title: string; before: string; after: string; impact?: string };
    }
  | { status: "error"; render: "error"; summary: string; code: string };
