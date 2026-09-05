import { getMessages } from "next-intl/server";
import { SETTINGS_DIRECTORY } from "@/lib/settings-directory";

type Messages = Awaited<ReturnType<typeof getMessages>>;
type Tree = Record<string, unknown>;

/**
 * The catalog is serialized into every page's HTML, so what a route's provider
 * carries is what a visitor downloads — all 97KB of it, on a sign-in form that
 * renders nine strings. These lists cut that per route.
 *
 * `manage` and `telegram` appear in no list at all: the manage tool's card labels
 * and the Telegram bot's replies are read only by server code, so a browser has
 * never had a use for either.
 *
 * Nesting a second provider REPLACES the messages rather than merging them
 * (`NextIntlClientProvider` is `use-intl`'s `IntlProvider`, which falls back to
 * the parent only when `messages` is undefined) — so every scope below is a
 * complete list, not a delta, and each one costs its own copy of BASE in the
 * flight payload. That is why there are four scopes and not one per segment.
 */
export const BASE_SCOPE = [
  "common",
  "errors",
  "theme",
  "language",
  "nav",
  "providerStatus",
  "updateBanner",
  "orgChangeBanner",
  // Any route can bounce to sign-in, and /pending + /suspended render nothing else.
  "auth",
  // The one settings string the signed-out shell shows, in its footer.
  "settings.general.openSourceShort",
];

/**
 * Everything a dashboard route shows before you open Settings itself.
 *
 * The Command-K palette resolves its rows against the ROOT catalog, so it needs
 * the exact settings keys the directory names. Those are derived from the
 * directory rather than listed here, because a hand-kept copy would drift the
 * moment someone adds a row — and the failure is a palette entry rendering its
 * own key.
 */
export const DASHBOARD_SCOPE = [
  "chat",
  "projects",
  "steps",
  "commandPalette",
  // The project hub shows the memory switches inline.
  "settings.memory",
  ...SETTINGS_DIRECTORY.flatMap((e) => [e.label, e.page, ...(e.keywordsKey ? [e.keywordsKey] : [])]),
];

/**
 * Settings pages replace the dashboard scope with the full namespace, and add back
 * the handful of chat strings they borrow — the model picker on Connections, the
 * changelog renderer on Updates, the file preview on Memory.
 */
export const SETTINGS_SCOPE = [
  "settings",
  // The agent-mode card is shared with the project dialog, and brings its strings.
  "projects.form.agent",
  "chat.citations",
  "chat.message",
  "chat.model",
  "chat.preview",
  "chat.workspace",
];

/** The wizard shows the model picker while the first provider is being added. */
export const SETUP_SCOPE = ["setup", "chat.model"];

/** A shared chat renders the real message components, for a signed-out reader. */
export const SHARE_SCOPE = ["chat", "steps"];

/** The harnesses under /dev mount chat components directly. */
export const DEV_SCOPE = ["chat"];

/**
 * BASE plus `scope`, where an entry is either a namespace ("chat") or a path
 * into one ("settings.memory").
 */
export async function clientMessages(scope: string[] = []): Promise<Messages> {
  return pickMessages((await getMessages()) as Tree, [...BASE_SCOPE, ...scope]) as Messages;
}

/** Split out so the scopes above can be checked without a request context. */
export function pickMessages(all: Tree, paths: string[]): Tree {
  const out: Tree = {};

  for (const path of paths) {
    const parts = path.split(".");
    let src = all;
    let dst = out;
    for (const key of parts.slice(0, -1)) {
      src = src[key] as Tree;
      // Copy instead of descending into the catalog's own objects: `getMessages`
      // hands back the imported JSON module, so writing a narrower path into a
      // node we borrowed from it would edit the catalog for the whole process.
      const held = dst[key];
      dst = dst[key] = (held && typeof held === "object" ? { ...held } : {}) as Tree;
    }
    dst[parts[parts.length - 1]] = src[parts[parts.length - 1]];
  }

  return out;
}
