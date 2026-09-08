/** The brand suffix every browser-tab title carries.
 *
 *  Next's metadata `template` cannot reach two of the three places that need it.
 *  A template stops being inherited the moment an intermediate segment returns a
 *  plain-string `title` — which is what left /settings/memory reading a bare
 *  "Memory" — so a nested layout has to restate it. And the live chat-title sync
 *  writes `document.title` on the client, where no template exists at all. One
 *  constant, so a rename stays one edit (this app has been renamed once already).
 */
export const TITLE_TEMPLATE = "%s · Capka";

/** `TITLE_TEMPLATE` applied by hand, for the client-side title writes.
 *
 *  The replacement is a function on purpose: a chat title is model-written text,
 *  and `$&` or `$1` inside it would be expanded as a replacement pattern by the
 *  string form of `replace`. */
export const withBrand = (title: string) => TITLE_TEMPLATE.replace("%s", () => title);
