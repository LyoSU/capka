export type Effect = "allow" | "deny" | "ask";
export type CapabilityType = "skill" | "connector";
export type PolicyScope = "system" | "user" | "project";

/** A policy row as served to the admin UI. */
export interface PolicyInfo {
  id: string;
  scope: PolicyScope;
  capabilityType: CapabilityType;
  capabilityKey: string;
  effect: Effect;
}

/** Minimal shape buildMatcher needs (pure-testable). */
export interface PolicyRow {
  scope: PolicyScope;
  capabilityType: CapabilityType;
  capabilityKey: string;
  effect: Effect;
}

/** Resolved policy lookup for one run. */
export interface PolicyMatcher {
  effect(type: CapabilityType, key: string): Effect;
}

export type AuditAction =
  | "plugin.install" | "plugin.uninstall" | "plugin.update" | "plugin.enable" | "plugin.disable"
  | "connector.add" | "connector.remove" | "connector.enable" | "connector.disable"
  | "skill.add" | "skill.remove" | "skill.enable" | "skill.disable"
  | "automation.add" | "automation.remove" | "automation.enable" | "automation.disable"
  | "folder.add" | "folder.remove"
  | "policy.set" | "policy.clear"
  // Chat-driven configuration changes via the `manage` control plane.
  | "settings.update" | "settings.undo"
  // Sensitive admin/security actions — privilege, account lifecycle, auth config,
  // master-key exposure, and instance billing/policy all belong in the
  // tamper-evident trail for companies.
  | "user.role_change" | "user.status_change" | "user.remove"
  | "auth_config.update" | "master_key.view" | "master_key.remove"
  | "billing.update";

/** Every AuditAction value, at runtime — the guard test asserts the i18n
 *  action dictionary covers this exactly, so a new action can never ship
 *  rendering as a raw key. */
export const AUDIT_ACTIONS = [
  "plugin.install", "plugin.uninstall", "plugin.update", "plugin.enable", "plugin.disable",
  "connector.add", "connector.remove", "connector.enable", "connector.disable",
  "skill.add", "skill.remove", "skill.enable", "skill.disable",
  "automation.add", "automation.remove", "automation.enable", "automation.disable",
  "folder.add", "folder.remove",
  "policy.set", "policy.clear",
  "settings.update", "settings.undo",
  "user.role_change", "user.status_change", "user.remove",
  "auth_config.update", "master_key.view", "master_key.remove",
  "billing.update",
] as const satisfies readonly AuditAction[];

// Compile-time completeness: if a new AuditAction is added to the union above
// but not to AUDIT_ACTIONS, this line fails typecheck naming the missing action.
type _MissingAuditAction = Exclude<AuditAction, (typeof AUDIT_ACTIONS)[number]>;
const _auditActionsExhaustive: [_MissingAuditAction] extends [never] ? true : _MissingAuditAction = true;
void _auditActionsExhaustive;

export interface AuditEntry {
  id: string;
  actorId: string | null;
  /** Resolved actor display name/email, joined at read time (null if the actor
   *  was a system action or the user has since been deleted). */
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetKey: string | null;
  detail: Record<string, unknown>;
  createdAt: Date | null;
}
