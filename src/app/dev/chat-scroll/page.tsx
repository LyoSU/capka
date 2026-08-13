import { notFound } from "next/navigation";
import { ScrollHarness } from "./harness";

/**
 * Test rig for the transcript's scroll engine — see `harness.tsx`.
 *
 * Double-gated on purpose. `NODE_ENV` alone is not enough: a self-hoster running a
 * dev build would still be exposing an unauthenticated page, so it also needs an
 * explicit opt-in. Both checks are server-side, and `notFound()` makes the route
 * indistinguishable from one that was never built.
 *
 * It needs no entry in the proxy's public paths: the proxy only checks that a
 * session cookie is PRESENT, so a test supplies any value and never touches the
 * session API. Keeping the auth perimeter untouched was worth more than the
 * convenience of exempting a path.
 *
 * NOT under a `_`-prefixed folder, however tempting that looks for something this
 * internal: Next treats a leading underscore as a private folder and drops it from
 * routing entirely, so the route 404s for a reason that has nothing to do with
 * either gate — and looks exactly like the gate working.
 */
export const dynamic = "force-dynamic";

export default function DevChatScrollPage() {
  if (process.env.NODE_ENV === "production" || process.env.CAPKA_SCROLL_HARNESS !== "1") notFound();
  return <ScrollHarness />;
}
