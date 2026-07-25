import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import en from "../../../messages/en.json";
import uk from "../../../messages/uk.json";
import { SETTINGS_DIRECTORY, searchSettings } from "../settings-directory";

/**
 * The settings search is a hand-declared index, so its failure mode is silent
 * rot: a renamed message key renders a raw `settings.foo.bar` string in the
 * result list, and a moved page produces a link to a 404. Neither shows up in
 * types, lint, or any page test — so it gets checked here instead.
 */
const lookup = (catalog: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], catalog);

describe("settings directory", () => {
  it("points every entry at a page that exists", () => {
    const missing = SETTINGS_DIRECTORY.filter((e) => {
      const route = e.href.split("#")[0].replace(/^\/settings\/?/, "");
      const dir = route ? `src/app/(dashboard)/settings/${route}` : "src/app/(dashboard)/settings";
      return !existsSync(`${dir}/page.tsx`);
    });
    expect(missing.map((m) => m.href)).toEqual([]);
  });

  it("resolves every label and page key in both locales", () => {
    const broken: string[] = [];
    for (const entry of SETTINGS_DIRECTORY) {
      for (const key of [entry.label, entry.page]) {
        for (const [name, catalog] of [["en", en], ["uk", uk]] as const) {
          if (typeof lookup(catalog, key) !== "string") broken.push(`${name}: ${key}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("has no duplicate entries", () => {
    // Two rows pointing at the same anchor means the same result appears twice,
    // which reads as a bug in the search rather than a duplicated declaration.
    const ids = SETTINGS_DIRECTORY.map((e) => `${e.href}|${e.label}`);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe("searchSettings", () => {
  const resolve = (key: string) => (lookup(uk, key) as string) ?? key;

  it("returns nothing for an empty query", () => {
    expect(searchSettings(SETTINGS_DIRECTORY, "   ", resolve)).toEqual([]);
  });

  it("finds a setting by a word from its own label", () => {
    const hits = searchSettings(SETTINGS_DIRECTORY, "інструкції", resolve);
    expect(hits[0].href).toBe("/settings/agent#agent-instructions");
  });

  it("finds a setting by a word the user would type instead of ours", () => {
    // Nothing on screen says "промпт" — that's the point of the keyword list.
    const hits = searchSettings(SETTINGS_DIRECTORY, "промпт", resolve);
    expect(hits.map((h) => h.href)).toContain("/settings/agent#agent-instructions");
  });

  it("ranks a label match above a keyword-only match", () => {
    // "пам'ять" is the memory switch's own name and merely a keyword elsewhere.
    const hits = searchSettings(SETTINGS_DIRECTORY, "пам'ять", resolve);
    expect(hits[0].href).toBe("/settings/memory#memory-enabled");
  });

  it("matches a typed phrase across the label and the keywords together", () => {
    // Someone describing what they want ("вимкнути пам'ять") types words that live
    // in different fields. Matching the phrase as one string would find nothing.
    const hits = searchSettings(SETTINGS_DIRECTORY, "вимкнути пам'ять", resolve);
    expect(hits.map((h) => h.href)).toContain("/settings/memory#memory-enabled");
  });

  it("requires every word to match something, so extra words narrow rather than widen", () => {
    // "пам'ять" alone hits several rows; adding a word that matches none of them
    // must return nothing rather than falling back to the loosest match.
    expect(searchSettings(SETTINGS_DIRECTORY, "пам'ять zzzz", resolve)).toEqual([]);
    expect(searchSettings(SETTINGS_DIRECTORY, "пам'ять", resolve).length).toBeGreaterThan(1);
  });

  it("respects the caller's filtering, so a member never sees admin-only rows", () => {
    const memberOnly = SETTINGS_DIRECTORY.filter((e) => !e.adminOnly);
    const hits = searchSettings(memberOnly, "промпт", resolve);
    expect(hits).toEqual([]);
  });
});
