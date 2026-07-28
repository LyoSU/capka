"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Inbox, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
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
export function SettingsSkeleton({
  rows = 3,
  wide,
  header = true,
}: {
  rows?: number;
  wide?: boolean;
  /**
   * Whether to include the ghost title. Off for a skeleton rendered *inside* a
   * `SettingsPage`, where the real title is already on screen — a grey heading
   * placeholder directly under it reads as a rendering fault, not as loading.
   */
  header?: boolean;
}) {
  return (
    // `wide` has to mirror SettingsPage: a skeleton fixed at max-w-2xl in front of
    // a max-w-5xl page snaps sideways the moment the real content lands, which is
    // the same jump this component exists to prevent — just on the other axis.
    <div className={cn("space-y-10", wide ? "max-w-5xl" : "max-w-2xl")} aria-hidden>
      {header && (
        <div className="space-y-2">
          <div className="h-6 w-40 animate-pulse rounded bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded bg-muted/60" />
        </div>
      )}
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
  icon = Inbox,
  title,
  hint,
  action,
}: {
  /** Defaults to a neutral tray, so an empty list is never a bare sentence. */
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <EmptyState icon={icon} title={title} hint={hint} className="rounded-xl border border-dashed">
      {action}
    </EmptyState>
  );
}

/**
 * What a section says when its data would not load.
 *
 * Sits where the content would have been, rather than in a toast that is gone
 * three seconds later — a page that failed to load has to keep saying so. Save
 * failures are the opposite case and stay toasts: the page is still right, one
 * action wasn't.
 */
export function SettingsError({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-destructive-border bg-destructive-surface px-4 py-3 text-sm text-destructive-text">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 leading-relaxed">{message}</p>
      {action}
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
  labelFor,
  hint,
  warning,
  disabled,
  control,
  onLabelClick,
  children,
}: {
  id?: string;
  title: string;
  /** Renders the title as a real `<label for>` — for rows whose control is a
   *  native input/textarea passed as `children`. Without it the title is a
   *  paragraph, which is correct for Switches (see `onLabelClick`) but would
   *  leave a text field unlabelled for a screen reader. */
  labelFor?: string;
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
  const { ref, highlighted } = useAnchorTarget(id);

  return (
    <div
      id={id}
      ref={ref}
      // Focusable only as a jump target, never in the tab order: after search
      // sends you here, the next Tab has to continue from the row rather than
      // from the top of the document.
      tabIndex={id ? -1 : undefined}
      className={cn(
        "px-4 py-3.5 outline-none transition-colors",
        onLabelClick && !disabled && "hover:bg-muted/30",
        // scroll-mt clears the sticky page header when jumped to from search.
        id && "scroll-mt-24",
        highlighted && "bg-primary/5 ring-1 ring-inset ring-primary/40",
      )}
    >
      <div className={cn("flex items-center justify-between gap-4", disabled && "opacity-60")}>
        <div
          className={cn("min-w-0 space-y-0.5", onLabelClick && !disabled && "cursor-pointer select-none")}
          onClick={onLabelClick && !disabled ? onLabelClick : undefined}
        >
          {labelFor ? (
            <label htmlFor={labelFor} className="block text-sm font-medium">{title}</label>
          ) : (
            <p className="text-sm font-medium">{title}</p>
          )}
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
 * Brings this row into view, focuses it, and tints it for ~1.6s whenever its id
 * is the URL hash.
 *
 * The scroll cannot be left to the browser, which is the obvious thing to try:
 * Next applies a hash exactly once, in a layout effect right after the
 * navigation commits, and at that moment every page with anchored rows is still
 * showing `SettingsSkeleton` while its settings load. `getElementById` finds
 * nothing, the hash is discarded, and the row later appears wherever it happens
 * to sit — often below the fold, tinted where nobody is looking. Scrolling from
 * the row's OWN mount effect is what fixes that: it runs when the element
 * demonstrably exists.
 *
 * `hashchange` is the second load-bearing listener: a further search hit on the
 * SAME page changes only the hash, which Next's router does not report as a
 * navigation, so an effect keyed on the pathname would fire once and go quiet.
 */
function useAnchorTarget(id?: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!id) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (window.location.hash.slice(1) !== id) return;
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      ref.current?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
      // preventScroll: scrollIntoView above already chose the position, and
      // focus() would otherwise re-scroll to its own idea of "visible".
      ref.current?.focus({ preventScroll: true });
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

  return { ref, highlighted: on };
}
