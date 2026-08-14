import { describe, it, expect } from "vitest";
import en from "../../../messages/en.json";
import uk from "../../../messages/uk.json";
import type { PluginEnabledState } from "@/lib/marketplace/service";

/**
 * Guardrails over the message catalogs themselves.
 *
 * `next-intl` renders a missing key as its own PATH rather than throwing, so an absent string
 * is not an error anywhere — it is a badge in the Plugins list reading
 * `settings.skills.installed.state.on`, which is how that one shipped. Nothing but a screenshot
 * catches it, unless a test does.
 */

/** Dotted leaf paths, so a key that moved between nesting levels reads as one gone and one new. */
function leaves(node: unknown, prefix = "", out: string[] = []): string[] {
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      leaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (prefix) out.push(prefix);
  return out;
}

const enKeys = new Set(leaves(en));
const ukKeys = new Set(leaves(uk));

describe("message catalogs", () => {
  it("translates every English key into Ukrainian", () => {
    // Ukrainian is a first-class locale here, not a later translation pass, so a key added to
    // one catalog and not the other is a defect and not a backlog item.
    expect([...enKeys].filter((k) => !ukKeys.has(k))).toEqual([]);
  });

  it("has no Ukrainian keys without an English counterpart, outside `manage.`", () => {
    // `manage.*` is deliberately uk-only: the chat control plane falls back to the in-code
    // English literal rather than a parallel en catalog that could drift from it
    // (see `manageT`/`loc` and manage/__tests__/i18n.test.ts). Everywhere else, a uk-only key
    // is a rename that only landed on one side.
    const orphans = [...ukKeys].filter((k) => !enKeys.has(k) && !k.startsWith("manage."));
    expect(orphans).toEqual([]);
  });
});

/**
 * A label group whose keys are a TypeScript union, checked against both catalogs.
 *
 * The `Record<Union, true>` is the load-bearing part: it makes the compiler refuse this file
 * when a member is added to the union, so the new state cannot reach a badge without a label.
 * That link is what `t(`state.${s}`)` severed — the union lived in one file, the strings in
 * another, and nothing in between. New enum-keyed groups belong here in the same shape.
 */
const UNION_LABEL_GROUPS: { path: string; members: Record<string, true> }[] = [
  {
    path: "settings.skills.installed.state",
    members: { on: true, off: true, mixed: true } satisfies Record<PluginEnabledState, true>,
  },
];

describe("labels for union-typed values", () => {
  for (const [locale, msgs] of Object.entries({ en, uk })) {
    for (const group of UNION_LABEL_GROUPS) {
      it(`${locale} labels every member of ${group.path}`, () => {
        const keys = locale === "en" ? enKeys : ukKeys;
        const missing = Object.keys(group.members).filter((m) => !keys.has(`${group.path}.${m}`));
        expect(missing, `missing ${locale} labels under ${group.path}`).toEqual([]);
        expect(msgs).toBeTruthy();
      });
    }
  }
});
