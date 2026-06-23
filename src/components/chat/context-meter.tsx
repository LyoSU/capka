import { useTranslations } from "next-intl";

/**
 * How full the model's context window is, derived from the last turn's actual
 * input usage against the effective window (model ∩ admin cap, persisted on the
 * reply's metadata). Stays hidden below 50% — no point nagging on short chats —
 * then appears, and turns amber near the ~75% mark where the server compacts.
 * Purely informational; compaction is automatic.
 */
export function ContextMeter({ used, window: limit }: { used: number; window: number }) {
  const t = useTranslations("chat.panel");
  const fraction = limit > 0 ? used / limit : 0;
  if (fraction < 0.5) return null;

  const pct = Math.min(100, Math.round(fraction * 100));
  const warn = fraction >= 0.75;
  return (
    <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-4 md:px-6 lg:max-w-4xl">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${warn ? "bg-amber-500" : "bg-primary/40"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs tabular-nums ${warn ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
        {t("contextFull", { pct })}
      </span>
    </div>
  );
}
