"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Cap a long list at a readable length, with a "show more" step.
 *
 * Client-side on purpose: these lists arrive whole (the admin routes return every
 * member, every capability), so paging them on the server would add round-trips
 * without removing a single row from memory. What actually hurt was rendering
 * two hundred rows into a page nobody scrolls to the bottom of.
 *
 * `resetKey` is whatever narrows the list — a search query, a role filter. It has
 * to reset the count, otherwise typing a search while expanded shows every match
 * at once, and clearing it leaves the old, larger count in place.
 */
export function useShowMore<T>(rows: T[], resetKey: string = "", step: number = 25) {
  const [count, setCount] = useState(step);
  useEffect(() => setCount(step), [resetKey, step]);
  return {
    visible: rows.slice(0, count),
    more: () => setCount((c) => c + step),
    total: rows.length,
  };
}

/** The control for {@link useShowMore}. Renders nothing once everything is out —
 *  a dead "show more" button under a complete list is a question with no answer. */
export function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  const t = useTranslations("settings");
  if (shown >= total) return null;
  return (
    <div className="flex items-center justify-center gap-3 pt-1">
      <button
        type="button"
        onClick={onMore}
        className="rounded-lg px-3 py-1.5 text-sm shadow-btn transition-micro hover:bg-hover active:scale-[0.98]"
      >
        {t("showMore")}
      </button>
      <span className="text-xs text-muted-foreground tabular-nums">{t("showingOf", { shown, total })}</span>
    </div>
  );
}
