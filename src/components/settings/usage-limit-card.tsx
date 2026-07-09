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

// Stacked bar: solid = committed (settled) spend, translucent = outstanding holds
// (estimates) on top, so a reservation never looks like money already spent.
function Bar({ committedPct, reservedPct }: { committedPct: number; reservedPct: number }) {
  const committedW = Math.min(100, committedPct);
  const reservedW = Math.min(100 - committedW, Math.max(0, reservedPct));
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full transition-[width]", barColor(committedPct + reservedPct))} style={{ width: `${committedW}%` }} />
      <div className={cn("h-full opacity-40 transition-[width]", barColor(committedPct + reservedPct))} style={{ width: `${reservedW}%` }} />
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
        {capped.map((w) => {
          const committedPct = w.limit ? Math.min(999, Math.round((w.committed / w.limit) * 100)) : 0;
          const reservedPct = w.limit ? Math.round((w.reserved / w.limit) * 100) : 0;
          return (
            <div key={w.window} className="space-y-1.5">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">{label(w)}</span>
                <span className="font-medium tabular-nums">
                  {t("usedPct", { pct: committedPct })}
                  {reservedPct > 0 && (
                    <span className="ml-1 font-normal text-muted-foreground">{t("reservedPct", { pct: reservedPct })}</span>
                  )}
                </span>
              </div>
              <Bar committedPct={committedPct} reservedPct={reservedPct} />
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </div>
  );
}
