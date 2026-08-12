"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";

/**
 * The one look for every admin heads-up strip stacked at the top of the app
 * (updates, provider health, org changes). Deliberately quiet — a muted bar, not
 * a coloured alarm — because these are ambient notices, not blocking errors. The
 * only per-notice signal is the icon the caller passes (e.g. a warning-tinted
 * glyph for something that matters more); the chrome stays the same.
 *
 * Each caller keeps its own fetch/dismiss logic and just renders through here, so
 * the layout, the close button, and the calm styling live in exactly one place.
 */
export function TopBanner({
  icon,
  children,
  action,
  onDismiss,
  dismissLabel,
}: {
  icon: ReactNode;
  children: ReactNode;
  action?: { href: string; label: string };
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    // role="status": every caller renders this only after an async check resolves,
    // so the bar appears some seconds into the session. Sighted users see the app
    // shift; without a live region a screen-reader user was never told at all.
    // flex-wrap is load-bearing: the action is shrink-0, so on one line the message
    // was the only item that could give — and a flex item bottoms out at its
    // min-content, i.e. one word per line. Padding is asymmetric because only the
    // right edge holds the close button.
    <div
      role="status"
      className="relative flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-border bg-muted/40 py-2 pl-4 pr-10 text-sm text-foreground sm:pl-10"
    >
      {icon}
      <span>{children}</span>
      {action && (
        <Link
          href={action.href}
          className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80"
        >
          {action.label}
        </Link>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-opacity hover:opacity-70"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
