import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  /** One calm sentence saying what to do next. Optional, but usually wanted. */
  hint?: string;
  /**
   * Operator-facing raw text (an HTTP body, a provider code). Surfaced as the
   * container's `title` so support can hover it — never rendered, because a
   * non-technical user reading a stack trace is the failure this app avoids.
   */
  detail?: string;
  /** Actions. A single primary button, or a button plus a quiet link. */
  children?: React.ReactNode;
  /**
   * `page` fills a route area (route-level empties, 404, error boundaries);
   * `panel` sits inside a card, drawer, or the 320px workspace panel.
   */
  size?: "page" | "panel";
  /**
   * The title's element. A route whose entire content is this state (404, an
   * empty list page) should own the document's `h1`; a state nested inside a
   * page that already has a heading must not, so the default is a plain `p`.
   */
  as?: "h1" | "h2" | "p";
  className?: string;
}

/**
 * The one shape every "there is nothing here" and "this didn't load" screen
 * uses: icon, title, one-sentence hint, a way forward. Two sizes, because the
 * app has exactly two contexts for them — a whole route, or a box inside one.
 *
 * It exists because the same idea had been rewritten a dozen times in a dozen
 * geometries: a dashed-border box here, a bare grey sentence there, nothing at
 * all in a few places. The bare sentence is the one worth naming as a bug — it
 * tells the user their screen is empty and offers no way out of it.
 *
 * `ErrorState` stays separate: it is a client component that reads the session
 * to decide whether an admin may expand the technical detail.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  detail,
  children,
  size = "panel",
  as: Title = "p",
  className,
}: EmptyStateProps) {
  const page = size === "page";

  return (
    <div
      title={detail}
      className={cn(
        "flex w-full flex-col items-center text-center",
        page ? "min-h-[60dvh] justify-center gap-5 p-6" : "gap-2 px-6 py-10",
        className,
      )}
    >
      {page ? (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-6 w-6" aria-hidden />
        </div>
      ) : (
        <Icon className="h-8 w-8 text-muted-foreground/30" aria-hidden />
      )}

      <div className={page ? "space-y-1.5" : "space-y-1"}>
        <Title className={page ? "text-lg font-semibold text-foreground" : "text-sm font-medium"}>
          {title}
        </Title>
        {hint && (
          <p
            className={cn(
              "mx-auto text-pretty text-muted-foreground",
              page ? "max-w-sm text-sm" : "max-w-[18rem] text-xs",
            )}
          >
            {hint}
          </p>
        )}
      </div>

      {children && (
        <div
          className={cn(
            "flex flex-wrap items-center justify-center gap-2",
            page ? "" : "mt-1",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
