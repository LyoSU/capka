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
 * The hierarchy here is deliberate and has exactly two levels: a section label
 * (small, muted, uppercase — the same treatment the sidebar gives its group
 * headers, so the two read as the same rank) and row titles inside it at normal
 * weight. Previously both were `text-sm font-medium`, which is why a section
 * heading and the first row under it looked identical.
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
    <div className={cn("space-y-8", wide ? "max-w-5xl" : "max-w-2xl")}>
      <div className="space-y-1">
        <h2 className="text-lg font-medium tracking-tight">{title}</h2>
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
      <div className="space-y-0.5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
      {footnote && <p className="text-xs leading-relaxed text-muted-foreground">{footnote}</p>}
    </section>
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
  children?: React.ReactNode;
}) {
  const highlighted = useAnchorHighlight(id);

  return (
    <div
      id={id}
      className={cn(
        "px-4 py-3.5 transition-colors",
        // scroll-mt clears the sticky page header when jumped to from search.
        id && "scroll-mt-24",
        highlighted && "bg-primary/5",
      )}
    >
      <div className={cn("flex items-center justify-between gap-4", disabled && "opacity-60")}>
        <div className="min-w-0 space-y-0.5">
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
