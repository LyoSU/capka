"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";

import type { PlanStep } from "@/lib/chat/plan";
import { cn } from "@/lib/utils";

/** The turn's plan as a checklist: ✓ done, a spinning ring on the current step,
 *  a hollow circle for what is next. Rows that arrive while it is on screen rise
 *  in one after another (`fade-up`, staggered by `--i`); a row's mark crossfades
 *  when its status changes. Reduced motion drops both via the global reset. */
export function PlanChecklist({ steps, live }: { steps: PlanStep[]; live?: boolean }) {
  const t = useTranslations("chat.message");
  // Only rows added after mount animate: a finished plan opened from history,
  // or the same plan re-rendered on every streamed token, stays still.
  const [initial] = useState(() => (live ? 0 : steps.length));
  return (
    <ol aria-label={t("plan")} className="flex flex-col gap-1 py-1">
      {steps.map((s, i) => (
        <li
          key={`${i}:${s.title}`}
          className={cn("flex items-start gap-2.5 text-sm", i >= initial && "animate-fade-up")}
          style={i >= initial ? ({ "--i": i - initial } as React.CSSProperties) : undefined}
        >
          <span className="sr-only">{t(`planStep.${s.status}`, { title: s.title })}</span>
          <span aria-hidden className="relative mt-0.5 grid size-4 shrink-0 place-items-center">
            {s.status === "done" ? (
              <span key="done" className="animate-step-in grid size-4 place-items-center rounded-full bg-brand text-white">
                <Check className="size-2.5" strokeWidth={3} />
              </span>
            ) : s.status === "current" && live ? (
              <span key="current" className="spinner-ring size-3.5 animate-spin rounded-full text-brand" />
            ) : (
              <span key="pending" className="size-3.5 rounded-full border border-muted-foreground/40" />
            )}
          </span>
          <span
            aria-hidden
            className={cn(
              "min-w-0 transition-colors duration-300",
              s.status === "pending" ? "text-muted-foreground" : "text-foreground",
              s.status === "current" && live && "font-medium",
            )}
          >
            {s.title}
          </span>
        </li>
      ))}
    </ol>
  );
}
