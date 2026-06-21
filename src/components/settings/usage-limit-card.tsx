"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBilling, type WindowStatus } from "@/hooks/use-billing";

// Bar colour escalates with pressure: calm under 75%, amber approaching, red at
// the cap. Purely informational — enforcement happens server-side.
function barColor(pct: number): string {
  if (pct >= 100) return "bg-destructive";
  if (pct >= 75) return "bg-amber-500";
  return "bg-primary";
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-all", barColor(pct))}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

/**
 * The user-facing budget widget. Shows spend as a PERCENTAGE only (never raw $),
 * leading with the most-constrained window and expanding to all three. Renders
 * nothing when the user isn't on the shared key or has no capped window — there's
 * simply no limit to report.
 */
export function UsageLimitCard() {
  const t = useTranslations("settings.limits");
  const { billing, loading } = useBilling();
  const [expanded, setExpanded] = useState(false);

  if (loading || !billing?.onSharedKey || !billing.limits) return null;

  const capped = billing.limits.windows.filter((w) => w.limit !== null);
  if (capped.length === 0) return null; // unlimited tier → nothing to show

  // Lead with whichever window is closest to its cap.
  const lead = capped.reduce((a, b) => (b.pct > a.pct ? b : a));
  const label = (w: WindowStatus) => t(`window.${w.window}`);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("title")}</h3>
        {billing.limits.blocked && (
          <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
            {t("reached")}
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">{label(lead)}</span>
          <span className="font-medium tabular-nums">{t("usedPct", { pct: lead.pct })}</span>
        </div>
        <Bar pct={lead.pct} />
      </div>

      {capped.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
            {expanded ? t("hideDetails") : t("details")}
          </button>

          {expanded && (
            <div className="space-y-3 pt-1">
              {capped.map((w) => (
                <div key={w.window} className="space-y-1.5">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">{label(w)}</span>
                    <span className="font-medium tabular-nums">{t("usedPct", { pct: w.pct })}</span>
                  </div>
                  <Bar pct={w.pct} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </div>
  );
}
