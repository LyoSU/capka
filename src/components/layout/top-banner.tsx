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
    <div className="relative flex items-center justify-center gap-2 border-b border-border bg-muted/40 px-10 py-2 text-sm text-foreground">
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
