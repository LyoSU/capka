import { useState } from "react";
import { useTranslations } from "next-intl";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useIsAdmin } from "@/hooks/use-is-admin";

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
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const fraction = limit > 0 ? used / limit : 0;
  if (fraction < 0.5) return null;

  const pct = Math.min(100, Math.round(fraction * 100));
  const warn = fraction >= 0.75;
  const r = 6.5;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(1, fraction));
  // `stroke-muted-foreground`, not the old `stroke-primary/50`. A 2px ring is
  // non-text UI, which WCAG holds to 3:1 — and half-strength primary on the pale
  // background landed under that, so the only "how full is this" cue was hard to
  // see for exactly the users who most need it. `--muted-foreground` is already
  // tuned for contrast in both themes, and semantically it IS a quiet indicator.
  const color = warn ? "stroke-warning-text" : "stroke-muted-foreground";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-label={t("contextFull", { pct })}
        className="flex shrink-0 items-center gap-1 rounded-md text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {warn && <span className="tabular-nums text-warning-text">{pct}%</span>}
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
            className={`${color} transition-[stroke-dashoffset,stroke] duration-300 ease-out`}
          />
        </svg>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="max-w-56 p-2.5 text-xs">
        <div className="font-medium text-popover-foreground">{t("contextFull", { pct })}</div>
        {/* What this means for the reader, not the number behind it. The exact
            token pair is telemetry: useful to whoever pays for the key, noise to
            someone who just wants to know whether the conversation is too long.
            It follows the same admin split as the (i) popover on a message. */}
        <div className="mt-0.5 text-muted-foreground">{t("contextHint")}</div>
        {isAdmin && (
          <div className="mt-1 whitespace-nowrap text-muted-foreground/80 tabular-nums">
            {t("contextTokens", { used: fmtTokens(used), total: fmtTokens(limit) })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
