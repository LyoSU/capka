import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
 * A key nothing renders.
 *
 * The parity checks above see only en↔uk, so a string present in BOTH catalogs and used by
 * NEITHER passes them both. Two shipped that way in one commit: `sensitiveHidden`, which
 * described a behaviour that had just been deliberately removed, and `openChat`, an
 * accessible name for a design that changed before it landed. Dead copy is not free — the
 * first invites someone to restore the behaviour it describes, and both make the catalog a
 * less trustworthy answer to "what does this screen say".
 *
 * Matching is on the LAST SEGMENT, because that is what a call site actually contains:
 * `useTranslations("settings.memory")` then `t("reviewHint")`. Deliberately loose — a leaf
 * named `title` matches almost anything — and loose in the safe direction: it can miss a
 * dead key, never condemn a live one. What it reliably catches is the distinctive name
 * nobody calls, which is the shape dead copy actually takes.
 */
const KEY_SOURCE_ROOTS = ["src"];

/**
 * Keys no call site can contain literally, because the call site builds them.
 *
 * Each entry names the file that constructs it. A prefix here is a claim that the group is
 * addressed dynamically and exhaustively — not a place to park a key that turned out to be
 * unused, which is what the check exists to find.
 */
const DYNAMIC_KEY_PREFIXES: { prefix: string; builtBy: string }[] = [
  { prefix: "settings.automations.weekday.", builtBy: "settings/automations/automation-editor.tsx — t(`weekday.w${i}`)" },
  { prefix: "settings.security.folder_", builtBy: "settings/security/page.tsx — t(`folder_${opt}`)" },
  { prefix: "projects.form.agent.background.", builtBy: "settings/agent-mode.tsx — t(`background.${k}`) over BACKGROUND_PASSES" },
];

/**
 * Dead keys that predate this check, kept OUT of the prefix list above because they are not
 * dynamic — they are unused, and they belong to features this check's author did not own.
 *
 * Asserted for EQUALITY, not as an allowlist, and that is the difference between an
 * inventory and a dumping ground: a key that gains a caller must be deleted from this list
 * or the test fails, and a new dead key fails it too. It only ever shrinks.
 */
const KNOWN_UNUSED: string[] = [
  // settings/users — a user dialog that shows activity and Telegram status differently now.
  "settings.usersPage.lastActivity",
  "settings.usersPage.tgConnected",
  "settings.usersPage.tgNotConnected",
  // marketplace upgrade review — written for review states the diff view does not render.
  "settings.skills.installed.review.requiresConsent",
  "settings.skills.installed.review.policyKeep",
  "settings.skills.installed.review.staleBody",
];

/** Product code only. Tests are excluded, and not as an optimization: a key referenced by
 *  nothing but a test — including `KNOWN_UNUSED` in THIS file, which is a list of dead key
 *  names and would otherwise keep every one of them alive — is still dead copy. */
function sourceText(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of KEY_SOURCE_ROOTS) walk(root);
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

describe("no message key without a reader", () => {
  const src = sourceText();

  it("scans the source tree at all", () => {
    // The control: an empty scan finds no orphans and passes for the wrong reason.
    expect(src).toContain("useTranslations");
    expect(src.length).toBeGreaterThan(1_000_000);
  });

  it("has exactly the known-unused keys, and no others", () => {
    const unused = [...enKeys]
      .filter((k) => !DYNAMIC_KEY_PREFIXES.some((d) => k.startsWith(d.prefix)))
      .filter((k) => {
        const leaf = k.split(".").pop() as string;
        return !new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(src);
      });
    expect(unused.sort()).toEqual([...KNOWN_UNUSED].sort());
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
