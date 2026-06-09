"use client";

import { useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Loader2 } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface Totals {
  cost: number;
  inputTokens: string | number;
  cachedInputTokens: string | number;
  outputTokens: string | number;
  calls: number;
}
interface ModelRow {
  model: string;
  cost: number;
  calls: number;
  inputTokens: string | number;
  outputTokens: string | number;
}
interface UserRow {
  userId: string;
  name: string | null;
  email: string | null;
  cost: number;
  calls: number;
}
interface UsageData {
  days: number;
  totals: Totals;
  byModel: ModelRow[];
  byUser: UserRow[];
}

const RANGES = [7, 30, 90] as const;

export default function UsagePage() {
  const t = useTranslations("settings.usage");
  const locale = useLocale();
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/usage?days=${days}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [days]);

  const money = (n: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n || 0);
  const num = (n: string | number) => new Intl.NumberFormat(locale).format(Number(n) || 0);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <ToggleGroup
          value={[String(days)]}
          onValueChange={(v) => {
            if (v.length) {
              setLoading(true);
              setDays(Number(v[0]));
            }
          }}
          variant="outline"
          size="sm"
        >
          {RANGES.map((r) => (
            <ToggleGroupItem key={r} value={String(r)} aria-label={t("rangeDays", { days: r })}>
              {t("rangeDays", { days: r })}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.totals.calls === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t("totalCost")} value={money(data.totals.cost)} />
            <Stat label={t("calls")} value={num(data.totals.calls)} />
            <Stat label={t("inputTokens")} value={num(data.totals.inputTokens)} />
            <Stat label={t("outputTokens")} value={num(data.totals.outputTokens)} />
          </div>

          {/* By model */}
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("byModel")}</h3>
            <div className="overflow-hidden rounded-lg border">
              {data.byModel.map((m, i) => (
                <div
                  key={m.model}
                  className={`flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm ${i > 0 ? "border-t" : ""}`}
                >
                  <span className="truncate font-mono text-xs">{m.model}</span>
                  <div className="flex shrink-0 items-center gap-4">
                    <span className="text-muted-foreground">{t("callsN", { count: m.calls })}</span>
                    <span className="w-20 text-right tabular-nums">{money(m.cost)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* By user */}
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("byUser")}</h3>
            <div className="overflow-hidden rounded-lg border">
              {data.byUser.map((u, i) => (
                <div
                  key={u.userId}
                  className={`flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm ${i > 0 ? "border-t" : ""}`}
                >
                  <span className="truncate">{u.name || u.email || t("unknownUser")}</span>
                  <div className="flex shrink-0 items-center gap-4">
                    <span className="text-muted-foreground">{t("callsN", { count: u.calls })}</span>
                    <span className="w-20 text-right tabular-nums">{money(u.cost)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
