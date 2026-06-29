"use client";

import { ViewTransition } from "react";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Wraps the dashboard's main pane so route navigations crossfade like an app.
 *
 * Desktop only. On phones the sidebar is a slide-out sheet, and selecting a chat
 * already animates the sheet closing — running a route view-transition on top of
 * it makes the browser snapshot-and-swap the whole viewport (sheet included)
 * mid-close, which flashes. So on mobile we render children WITHOUT a
 * `<ViewTransition>` at all: with no transition component in the tree React never
 * calls `startViewTransition`, the content just swaps instantly under the closing
 * sheet (the native drawer pattern), and nothing flashes.
 *
 * `useIsMobile` reports false on the first paint and resolves after mount, which
 * matches the server render (no hydration mismatch) and is settled long before
 * the user can navigate. `<ViewTransition>` renders no DOM node of its own, so
 * toggling the wrapper never changes the markup.
 */
export function RouteTransition({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  if (isMobile) return <>{children}</>;
  return <ViewTransition>{children}</ViewTransition>;
}
