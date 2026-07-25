"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The shared skeleton every settings page is built from.
 *
 * Before this existed each page hand-rolled its own header, its own content
 * width (there were four: max-w-lg / 2xl / 3xl / 4xl, so the column jumped
 * width as you moved between pages), and wrapped every single control in its
 * own bordered card — five switches read as five unrelated boxes. Three
 * grouping devices competed at once: a Separator, a heading, and a border.
 *
 * Hierarchy comes from position and space, not from shouting. The page title is
 * the only large text; a section heading and the row titles under it share a size,
 * and what separates them is that the rows sit inside a card and the section does
 * not. An earlier draft made section headings small-caps to force the distinction —
 * which made every section look like a label on a form from 2015. Uppercase
 * micro-headings stay in the sidebar, where they group navigation, not content.
 */

/** One settings page: fixed content width plus the title/description header. */
export function SettingsPage({
  title,
  description,
  wide,
  children,
}: {
  title: string;
  description?: string;
  /** For pages whose content is a table (users, analytics, activity) rather
   *  than a column of controls. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-10", wide ? "max-w-5xl" : "max-w-2xl")}>
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** A titled band of related settings. `footnote` is where the long explanation
 *  goes — the prose that used to bloat every row to four lines. */
export function SettingsSection({
  title,
  description,
  footnote,
  children,
}: {
  title: string;
  description?: string;
  footnote?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
      {footnote && <p className="text-xs leading-relaxed text-muted-foreground">{footnote}</p>}
    </section>
  );
}

/**
 * Placeholder rows in the shape of the real ones, for while a page loads.
 *
 * Replaces a centred spinner: the spinner sat in an empty page and the content
 * then appeared at a different height, so every settings page visibly jumped
 * once. A skeleton that matches the final layout has nowhere to jump to.
 */
export function SettingsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="max-w-2xl space-y-10" aria-hidden>
      <div className="space-y-2">
        <div className="h-6 w-40 animate-pulse rounded bg-muted" />
        <div className="h-4 w-72 animate-pulse rounded bg-muted/60" />
      </div>
      <div className="space-y-3">
        <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
        <SettingsGroup>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted/60" />
              </div>
              <div className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
            </div>
          ))}
        </SettingsGroup>
      </div>
    </div>
  );
}

/**
 * What a list says when it has nothing in it yet.
 *
 * An empty table with headers reads as "something failed to load"; a sentence
 * plus the one action that would fill it reads as "you haven't started". The
 * action is optional — some lists (an audit log on a fresh instance) are empty
 * for a good reason and nothing needs doing about it.
 */
export function SettingsEmpty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** One card holding several rows separated by hairlines, instead of one card
 *  per row. This is what turns a wall of boxes back into a list. */
export function SettingsGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("divide-y overflow-hidden rounded-xl border bg-card", className)}>{children}</div>;
}

/**
 * A single setting: label and short hint on the left, control on the right.
 *
 * `id` doubles as the deep-link anchor the settings search jumps to, which is
 * the whole reason rows are addressable at all — without it a search result
 * could only drop the user at the top of the page and leave them scanning.
 */
export function SettingsRow({
  id,
  title,
  hint,
  warning,
  disabled,
  control,
  onLabelClick,
  children,
}: {
  id?: string;
  title: string;
  hint?: React.ReactNode;
  /** Amber note under the hint — a blocked/needs-attention state. */
  warning?: React.ReactNode;
  /** Dims the text to match a disabled control. The control itself still has to
   *  be passed disabled; this only keeps the label from looking active. */
  disabled?: boolean;
  /** The switch/select/button. Omit and pass `children` for a control that
   *  needs the full row width (a segmented picker, a textarea). */
  control?: React.ReactNode;
  /**
   * Makes the label text a click target for the control, so the row behaves the
   * way every OS settings list does instead of demanding a hit on a 36px switch.
   *
   * Not done with a native `<label>`: the Switch renders a `role="switch"` button,
   * and label-for association only activates real form inputs — it would look
   * clickable and do nothing. Bound to the text block rather than the whole row so
   * a click on the switch itself can't fire this too and cancel its own change.
   */
  onLabelClick?: () => void;
  children?: React.ReactNode;
}) {
  const highlighted = useAnchorHighlight(id);

  return (
    <div
      id={id}
      className={cn(
        "px-4 py-3.5 transition-colors",
        onLabelClick && !disabled && "hover:bg-muted/30",
        // scroll-mt clears the sticky page header when jumped to from search.
        id && "scroll-mt-24",
        highlighted && "bg-primary/5",
      )}
    >
      <div className={cn("flex items-center justify-between gap-4", disabled && "opacity-60")}>
        <div
          className={cn("min-w-0 space-y-0.5", onLabelClick && !disabled && "cursor-pointer select-none")}
          onClick={onLabelClick && !disabled ? onLabelClick : undefined}
        >
          <p className="text-sm font-medium">{title}</p>
          {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
          {warning && <p className="text-xs font-medium text-amber-600 dark:text-amber-500">{warning}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className={cn("mt-3", disabled && "opacity-60")}>{children}</div>}
    </div>
  );
}

/**
 * True for ~1.6s after this row's id lands in the URL hash.
 *
 * Scrolling is left to the browser (the `id` attribute is enough) — this only
 * adds the tint, because landing mid-page with no visual answer to "which one
 * did I search for" is the part scrolling alone doesn't solve. `hashchange` is
 * the load-bearing listener: a second search hit on the SAME page changes only
 * the hash, which Next's router does not report as navigation, so an effect
 * keyed on the pathname would flash once and then go quiet.
 */
function useAnchorHighlight(id?: string) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!id) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (window.location.hash.slice(1) !== id) return;
      setOn(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOn(false), 1600);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => {
      window.removeEventListener("hashchange", check);
      clearTimeout(timer);
    };
  }, [id]);

  return on;
}
