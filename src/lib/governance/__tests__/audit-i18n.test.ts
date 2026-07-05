import { describe, it, expect } from "vitest";
import { AUDIT_ACTIONS } from "../types";
import en from "../../../../messages/en.json";
import uk from "../../../../messages/uk.json";

/**
 * Guardrail: the Activity page renders every audit action via
 * `settings.activity.actions.<action>`. A new AuditAction that ships without a
 * translation would render as a raw key (e.g. "auth_config.update") — the exact
 * regression this suite prevents. AUDIT_ACTIONS itself is kept exhaustive by a
 * compile-time check in types.ts, so covering it here covers the whole union.
 */
const locales = { en, uk } as const;

// Actions are stored nested (e.g. actions.plugin.install) because next-intl
// forbids "." inside a key — it's the path separator. Resolve a dotted action
// by walking that nesting, exactly as `t("actions.<action>")` does at runtime.
function resolve(root: unknown, action: string): string | undefined {
  let node: unknown = root;
  for (const seg of action.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "string" ? node : undefined;
}

// Flatten the nested action tree back to dotted leaf paths, to catch stale keys.
function leaves(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("audit action translations", () => {
  for (const [name, msgs] of Object.entries(locales)) {
    const actions = (msgs as typeof en).settings.activity.actions;

    it(`${name} has a label for every audit action`, () => {
      const missing = AUDIT_ACTIONS.filter((a) => !resolve(actions, a));
      expect(missing, `missing ${name} labels`).toEqual([]);
    });

    it(`${name} has no stale audit-action labels`, () => {
      const known = new Set<string>(AUDIT_ACTIONS);
      const extra = leaves(actions).filter((k) => !known.has(k));
      expect(extra, `stale ${name} labels`).toEqual([]);
    });
  }
});
