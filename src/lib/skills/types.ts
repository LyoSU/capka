/** Scope tiers, most-specific last. Precedence on name collision: project > user > system. */
export type SkillScope = "system" | "user" | "project";

/**
 * Unified secret/config descriptor — the normalization target for MCP
 * `environmentVariables`, Glama JSON-schema, Smithery `configSchema`, Docker
 * `secrets`. Defined now as a forward-compat seam (sub-projects B/C reuse it);
 * pure-markdown skills do not populate it yet.
 */
export interface SecretDescriptor {
  name: string;
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  default?: string;
}

/** Result of parsing a SKILL.md file. */
export interface ParsedSkill {
  name: string;
  description?: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

/** A skill row as served to the run / UI. */
export interface SkillInfo {
  id: string;
  scope: SkillScope;
  name: string;
  description: string | null;
  body: string;
  enabled: boolean;
}

export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
  }
}
