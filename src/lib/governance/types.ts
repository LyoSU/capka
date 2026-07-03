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
  // and master-key exposure all belong in the tamper-evident trail for companies.
  | "user.role_change" | "user.status_change" | "user.remove"
  | "auth_config.update" | "master_key.view" | "master_key.remove";

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetKey: string | null;
  detail: Record<string, unknown>;
  createdAt: Date | null;
}
