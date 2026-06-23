import { useState } from "react";
import { useTranslations } from "next-intl";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

/** Compact token count: 1240 → "1k", 124000 → "124k", 1200000 → "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * A small ring that fills as the model's context window fills, derived from the
 * last turn's actual input usage against the effective window (model ∩ admin
 * cap). Sits just left of the send button — deliberately unobtrusive (a ring,
 * not a full-width bar). Hover (or tap) reveals an island with the exact
 * figures, rendered via a portal so the composer's `overflow-hidden` can't clip
 * it. Hidden below 50%, turns amber near the ~75% mark where the server
 * compacts. Purely informational; compaction is automatic.
 */
export function ContextMeter({ used, window: limit }: { used: number; window: number }) {
  const t = useTranslations("chat.panel");
  const [open, setOpen] = useState(false);
  const fraction = limit > 0 ? used / limit : 0;
  if (fraction < 0.5) return null;

  const pct = Math.min(100, Math.round(fraction * 100));
  const warn = fraction >= 0.75;
  const r = 6.5;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(1, fraction));
  const color = warn ? "stroke-amber-500" : "stroke-primary/50";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-label={t("contextFull", { pct })}
        className="flex shrink-0 items-center gap-1 rounded-md text-xs text-muted-foreground outline-none"
      >
        {warn && <span className="tabular-nums text-amber-600 dark:text-amber-400">{pct}%</span>}
        <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0" aria-hidden>
          <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-muted" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            transform="rotate(-90 8 8)"
            className={`${color} transition-all`}
          />
        </svg>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="p-2.5 text-xs">
        <div className="font-medium text-popover-foreground">{t("contextFull", { pct })}</div>
        <div className="mt-0.5 whitespace-nowrap text-muted-foreground">
          {t("contextTokens", { used: fmtTokens(used), total: fmtTokens(limit) })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
