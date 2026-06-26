"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

interface Totals {
  cost: number;
  sharedCost: number;
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
  cachedInputTokens: string | number;
  outputTokens: string | number;
}
interface UserRow {
  userId: string;
  name: string | null;
  email: string | null;
  cost: number;
  calls: number;
}
interface SeriesPoint {
  day: string;
  cost: number;
  calls: number;
}
interface RecentRow {
  id: string;
  createdAt: string;
  model: string;
  cost: number;
  inputTokens: string | number;
  outputTokens: string | number;
  userName: string | null;
  userEmail: string | null;
}
interface UsageData {
  days: number;
  totals: Totals;
  prev: { cost: number; calls: number };
  series: SeriesPoint[];
  byModel: ModelRow[];
  byUser: UserRow[];
  recent: RecentRow[];
}

type T = ReturnType<typeof useTranslations>;

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
  // Sub-cent costs round to $0.00; show more precision so small spend stays legible.
  const moneyPrecise = (n: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: n > 0 && n < 1 ? 4 : 2,
    }).format(n || 0);
  const num = (n: string | number) => new Intl.NumberFormat(locale).format(Number(n) || 0);
  const compact = (n: string | number) =>
    new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(Number(n) || 0);
  const pct = (n: number) =>
    new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(n);

  // ── Derived analytics (the numbers admins actually act on) ──
  const totalCost = data?.totals.cost || 0;
  const inTok = Number(data?.totals.inputTokens) || 0;
  const cachedTok = Number(data?.totals.cachedInputTokens) || 0;
  const outTok = Number(data?.totals.outputTokens) || 0;
  const totalTok = inTok + cachedTok + outTok;
  const promptTok = inTok + cachedTok;
  const cacheRate = promptTok > 0 ? cachedTok / promptTok : 0;
  const calls = data?.totals.calls || 0;
  const avgCost = calls > 0 ? totalCost / calls : 0;
  const dailyAvg = data ? totalCost / data.days : 0;
  const projectedMonthly = dailyAvg * 30; // run-rate: spend if the current pace holds
  const blendedPerM = totalTok > 0 ? (totalCost / totalTok) * 1_000_000 : 0;

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
          {/* Headline KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={t("totalCost")}
              value={money(totalCost)}
              sub={t("onSharedKey", { cost: moneyPrecise(data.totals.sharedCost || 0) })}
              delta={<Trend cur={totalCost} prev={data.prev?.cost ?? 0} tone="cost" t={t} pct={pct} />}
            />
            <Stat
              label={t("projectedMonthly")}
              value={money(projectedMonthly)}
              sub={t("perDay", { cost: moneyPrecise(dailyAvg) })}
            />
            <Stat
              label={t("calls")}
              value={num(calls)}
              delta={<Trend cur={calls} prev={data.prev?.calls ?? 0} tone="neutral" t={t} pct={pct} />}
            />
            <Stat label={t("avgPerRequest")} value={moneyPrecise(avgCost)} sub={t("perRequestHint")} />
          </div>

          {/* Daily cost trend */}
          <DailyChart series={data.series} days={data.days} dailyAvg={dailyAvg} money={money} locale={locale} t={t} />

          {/* Efficiency strip — "how" the budget is spent, not just how much */}
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t("totalTokens")} value={compact(totalTok)} sub={t("tokenSplit", { input: compact(promptTok), output: compact(outTok) })} />
            <Stat label={t("cacheRate")} value={pct(cacheRate)} sub={t("cachedTokens", { tokens: compact(cachedTok) })} />
            <Stat label={t("blendedRate")} value={money(blendedPerM)} sub={t("perMillionTokens")} />
          </div>

          {/* By model */}
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("byModel")}</h3>
            <Breakdown
              rows={data.byModel.map((m) => {
                const tok = Number(m.inputTokens) + Number(m.cachedInputTokens) + Number(m.outputTokens);
                const perM = tok > 0 ? (m.cost / tok) * 1_000_000 : 0;
                return {
                  key: m.model,
                  label: <span className="truncate font-mono text-xs">{m.model}</span>,
                  meta: t("modelMeta", { rate: money(perM), tokens: compact(tok) }),
                  calls: m.calls,
                  cost: m.cost,
                };
              })}
              total={totalCost}
              money={money}
              pct={pct}
              t={t}
            />
          </section>

          {/* By user */}
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("byUser")}</h3>
            <Breakdown
              rows={data.byUser.map((u) => ({
                key: u.userId,
                label: <span className="truncate">{u.name || u.email || t("unknownUser")}</span>,
                meta: u.calls > 0 ? t("userMeta", { cost: moneyPrecise(u.cost / u.calls) }) : undefined,
                calls: u.calls,
                cost: u.cost,
              }))}
              total={totalCost}
              money={money}
              pct={pct}
              t={t}
            />
          </section>

          {/* Recent activity */}
          {data.recent?.length ? (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("recentActivity")}</h3>
              <div className="overflow-hidden rounded-lg border">
                {data.recent.map((r, i) => (
                  <RecentItem key={r.id} row={r} money={moneyPrecise} compact={compact} locale={locale} t={t} border={i > 0} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <p className="text-lg font-semibold tabular-nums">{value}</p>
        {delta}
      </div>
      {sub ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/** Percent change vs the previous equal-length window, as a small colored badge. */
function Trend({
  cur,
  prev,
  tone,
  t,
  pct,
}: {
  cur: number;
  prev: number;
  tone: "cost" | "neutral";
  t: T;
  pct: (n: number) => string;
}) {
  if (!prev) return null;
  const change = (cur - prev) / prev;
  if (Math.abs(change) < 0.005) return null;
  const up = change > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  // For cost, more spend is "bad" (rose); for neutral counts, just hint direction.
  const color = tone === "cost" ? (up ? "text-rose-500" : "text-emerald-500") : "text-muted-foreground";
  return (
    <span className={cn("flex items-center gap-0.5 text-[11px] font-medium tabular-nums", color)} title={t("vsPrevious")}>
      <Icon className="h-3 w-3" />
      {pct(Math.abs(change))}
    </span>
  );
}

/** A list of cost rows, each with a proportional bar showing its share of total. */
function Breakdown({
  rows,
  total,
  money,
  pct,
  t,
}: {
  rows: { key: string; label: React.ReactNode; meta?: string; calls: number; cost: number }[];
  total: number;
  money: (n: number) => string;
  pct: (n: number) => string;
  t: T;
}) {
  const max = Math.max(...rows.map((r) => r.cost), 0);
  return (
    <div className="overflow-hidden rounded-lg border">
      {rows.map((r, i) => {
        const share = total > 0 ? r.cost / total : 0;
        return (
          <div key={r.key} className={cn("relative px-3.5 py-2.5", i > 0 && "border-t")}>
            {/* Proportional fill behind the row, scaled to the largest spender. */}
            <div
              className="absolute inset-y-0 left-0 bg-primary/[0.07]"
              style={{ width: `${max > 0 ? (r.cost / max) * 100 : 0}%` }}
              aria-hidden
            />
            <div className="relative flex items-center justify-between gap-3 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                {r.label}
                {r.meta ? <span className="shrink-0 text-xs text-muted-foreground">· {r.meta}</span> : null}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="hidden text-muted-foreground sm:inline">{t("callsN", { count: r.calls })}</span>
                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{pct(share)}</span>
                <span className="w-20 text-right font-medium tabular-nums">{money(r.cost)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Inline SVG bar chart of daily cost over the window, with an average reference line. */
function DailyChart({
  series,
  days,
  dailyAvg,
  money,
  locale,
  t,
}: {
  series: SeriesPoint[];
  days: number;
  dailyAvg: number;
  money: (n: number) => string;
  locale: string;
  t: T;
}) {
  const buckets = useMemo(() => {
    const byDay = new Map(series.map((s) => [s.day, s]));
    const out: { day: string; cost: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ day: key, cost: Number(byDay.get(key)?.cost ?? 0) });
    }
    return out;
  }, [series, days]);

  const max = Math.max(...buckets.map((b) => b.cost), 0);
  if (max <= 0) return null;

  const W = 720;
  const H = 120;
  const n = buckets.length;
  const slot = W / n;
  const barW = Math.max(1, slot * 0.62);
  const avgY = H - (dailyAvg / max) * (H - 4);
  const dateFmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">{t("dailyTrend")}</h3>
        <span className="text-xs text-muted-foreground">{t("peakDay", { cost: money(max) })}</span>
      </div>
      <div className="rounded-lg border p-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" role="img">
          {buckets.map((b, i) => {
            const h = (b.cost / max) * (H - 4);
            return (
              <rect
                key={b.day}
                x={i * slot + (slot - barW) / 2}
                y={H - h}
                width={barW}
                height={h}
                rx={Math.min(2, barW / 2)}
                className="fill-current text-primary/70 transition-colors hover:text-primary"
              >
                <title>{`${dateFmt.format(new Date(b.day))} — ${money(b.cost)}`}</title>
              </rect>
            );
          })}
          {dailyAvg > 0 ? (
            <line
              x1={0}
              x2={W}
              y1={avgY}
              y2={avgY}
              className="stroke-muted-foreground/50"
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
          <span>{dateFmt.format(new Date(buckets[0].day))}</span>
          <span>{t("avgLine", { cost: money(dailyAvg) })}</span>
          <span>{dateFmt.format(new Date(buckets[buckets.length - 1].day))}</span>
        </div>
      </div>
    </section>
  );
}

/** Format an absolute timestamp as a short relative phrase ("3h ago"). */
function relativeTime(iso: string, locale: string) {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (Math.abs(min) < 60) return rtf.format(-min, "minute");
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return rtf.format(-hr, "hour");
  return rtf.format(-Math.round(hr / 24), "day");
}

/** One spend event: who, which model, how many tokens, what it cost, when. */
function RecentItem({
  row,
  money,
  compact,
  locale,
  t,
  border,
}: {
  row: RecentRow;
  money: (n: number) => string;
  compact: (n: string | number) => string;
  locale: string;
  t: T;
  border: boolean;
}) {
  const who = row.userName || row.userEmail || t("unknownUser");
  const tokens = Number(row.inputTokens) + Number(row.outputTokens);
  return (
    <div className={cn("flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm", border && "border-t")}>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{who}</span>
        <span className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{row.model}</span> · {t("tokensN", { tokens: compact(tokens) })}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className="font-medium tabular-nums">{money(row.cost)}</span>
        <span className="text-xs text-muted-foreground">{relativeTime(row.createdAt, locale)}</span>
      </div>
    </div>
  );
}
