import { describe, it, expect } from "vitest";
import uk from "../../../messages/uk.json";
import { BASE_SCOPE, DASHBOARD_SCOPE, SETTINGS_SCOPE, pickMessages } from "../messages";
import { SETTINGS_DIRECTORY } from "@/lib/settings-directory";

/**
 * The route scopes in `../messages.ts` are lists a human maintains, and a missing
 * entry does not throw: next-intl renders the key path instead, so a namespace
 * dropped from a scope ships as `chat.input.placeholder` printed in the composer.
 * These are the checks that would notice.
 */

type Tree = Record<string, unknown>;
const catalog = uk as unknown as Tree;

function resolve(tree: Tree, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree);
}

describe("client message scopes", () => {
  it("covers every key the Command-K palette resolves against the root catalog", () => {
    // The palette lives in the dashboard layout, so it renders on every chat and
    // project page — with only the slice of `settings` this scope carries.
    const picked = pickMessages(catalog, [...BASE_SCOPE, ...DASHBOARD_SCOPE]);
    const unresolved = SETTINGS_DIRECTORY.flatMap((e) =>
      [e.label, e.page, ...(e.keywordsKey ? [e.keywordsKey] : [])].filter(
        (k) => typeof resolve(picked, k) !== "string",
      ),
    );
    expect(unresolved).toEqual([]);
  });

  it("leaves no namespace without a route that provides it", () => {
    // A new top-level namespace is invisible until some scope names it. The two
    // exceptions are read only by server code — the manage tool's card labels and
    // the Telegram bot's replies — and belong in no browser payload.
    const served = new Set(
      [...BASE_SCOPE, ...DASHBOARD_SCOPE, ...SETTINGS_SCOPE, "setup"].map((p) => p.split(".")[0]),
    );
    const serverOnly = ["manage", "telegram"];
    expect(Object.keys(catalog).filter((ns) => !served.has(ns) && !serverOnly.includes(ns))).toEqual([]);
  });

  it("never writes into the catalog it reads", () => {
    // `getMessages()` hands back the imported JSON module itself, shared by every
    // request in the process. Picking a narrow path after a wide one is where a
    // borrowed node would get edited.
    const before = JSON.stringify(catalog);
    pickMessages(catalog, ["settings", "settings.memory", "settings.nav.general"]);
    expect(JSON.stringify(catalog)).toBe(before);
  });

  it("keeps a wider path from being narrowed by a later one", () => {
    const picked = pickMessages(catalog, ["settings.memory", "settings.nav.general"]) as Tree;
    const settings = picked.settings as Tree;
    expect(Object.keys(settings).sort()).toEqual(["memory", "nav"]);
    expect(Object.keys(settings.memory as Tree).length).toBeGreaterThan(1);
    expect(Object.keys(settings.nav as Tree)).toEqual(["general"]);
  });
});
