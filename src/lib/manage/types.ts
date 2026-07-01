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
  | { action: "undo"; undoToken: string };

/** A change the UI renders as a SettingChangeCard (before→after diff + Undo). */
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
      status: "confirm_required";
      render: "confirm";
      summary: string;
      confirmToken: string;
      preview: { controlId: string; title: string; before: string; after: string; impact?: string };
    }
  | { status: "error"; render: "error"; summary: string; code: string };
