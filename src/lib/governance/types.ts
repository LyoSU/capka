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
  | "plugin.install" | "plugin.uninstall"
  | "connector.add" | "connector.remove" | "connector.enable" | "connector.disable"
  | "policy.set" | "policy.clear";

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetKey: string | null;
  detail: Record<string, unknown>;
  createdAt: Date | null;
}
