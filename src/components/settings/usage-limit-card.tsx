"use client";

import { useTranslations } from "next-intl";
import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBilling, type WindowStatus } from "@/hooks/use-billing";

// Bar colour escalates with pressure: calm under 75%, amber approaching, red at
// the cap. Purely informational — enforcement happens server-side.
function barColor(pct: number): string {
  if (pct >= 100) return "bg-destructive";
  if (pct >= 75) return "bg-warning-text";
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
 * listing every capped window at once — there are at most three short rows, so
 * hiding them behind a toggle costs more than it saves. Renders nothing when the
 * user isn't on the shared key or has no capped window — no limit to report.
 */
export function UsageLimitCard() {
  const t = useTranslations("settings.limits");
  const { billing, loading } = useBilling();

  if (loading || !billing?.onSharedKey || !billing.limits) return null;

  const capped = billing.limits.windows.filter((w) => w.limit !== null);
  if (capped.length === 0) return null; // unlimited tier → nothing to show

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

      <div className="space-y-3">
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

      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </div>
  );
}
