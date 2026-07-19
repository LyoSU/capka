"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { TrendingDown, TrendingUp, Search, X, SlidersHorizontal, AlertTriangle } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

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
  userId: string;
  userName: string | null;
  userEmail: string | null;
}
interface ProjectRow {
  projectId: string | null;
  name: string | null;
  cost: number;
  calls: number;
}
interface ChannelRow {
  channel: string;
  cost: number;
  calls: number;
}
interface TurnCounts {
  completed: number;
  failed: number;
  cancelled: number;
}
interface MemberTurn {
  userId: string;
  turns: number;
  lastAt: string | null;
}
type AttentionTrigger =
  | { type: "budget-overrun-projected"; projected: number; budget: number }
  | { type: "member-near-budget"; userId: string; name: string; used: number; cap: number; pct: number }
  | { type: "failure-spike"; rate: number; prevRate: number; turns: number }
  | { type: "idle-seats"; count: number; names: string[] };

interface UsageData {
  days: number;
  scope: Scope;
  filters: Filters;
  totals: Totals;
  prev: { cost: number; calls: number };
  series: SeriesPoint[];
  byModel: ModelRow[];
  byUser: UserRow[];
  recent: RecentRow[];
  byProject: ProjectRow[];
  byChannel: ChannelRow[];
  turns: TurnCounts;
  prevTurns: TurnCounts;
  activeMembers: number;
  withAccess: number;
  memberTurns: MemberTurn[];
  budget: { monthly: number | null };
  attention: AttentionTrigger[];
  options: { members: { id: string; name: string | null }[]; projects: { id: string; name: string | null }[]; models: string[] };
}

type T = ReturnType<typeof useTranslations>;
type Scope = "shared" | "own";
type Tab = "overview" | "models" | "people";
type Filters = { userId: string | null; model: string | null; projectId: string | null; channel: string | null };

const RANGES = [7, 30, 90] as const;
const SCOPES: Scope[] = ["shared", "own"];
const TABS: Tab[] = ["overview", "models", "people"];
const CHANNELS = ["web", "telegram", "automation"] as const;
const EMPTY_FILTERS: Filters = { userId: null, model: null, projectId: null, channel: null };

export default function UsagePage() {
  const t = useTranslations("settings.usage");
  const locale = useLocale();
  const [days, setDays] = useState<number>(30);
  const [scope, setScope] = useState<Scope>("shared");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [userQuery, setUserQuery] = useState("");
  // Clicking a person in "People" drills the recent-activity list down to just
  // them — the answer to "who is spending, and on what?".
  const [selectedUser, setSelectedUser] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ days: String(days), scope });
    if (filters.userId) params.set("userId", filters.userId);
    if (filters.model) params.set("model", filters.model);
    if (filters.projectId) params.set("projectId", filters.projectId);
    if (filters.channel) params.set("channel", filters.channel);
    fetch(`/api/admin/usage?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [days, scope, filters.userId, filters.model, filters.projectId, filters.channel]);

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
  const dailyAvg = data ? totalCost / data.days : 0;
  const projectedMonthly = dailyAvg * 30; // run-rate: spend if the current pace holds
  const blendedPerM = totalTok > 0 ? (totalCost / totalTok) * 1_000_000 : 0;

  const turns = data?.turns ?? { completed: 0, failed: 0, cancelled: 0 };
  const totalTurns = turns.completed + turns.failed + turns.cancelled;
  const concluded = turns.completed + turns.failed;
  const failRate = concluded > 0 ? turns.failed / concluded : 0;
  const costPerTurn = turns.completed > 0 ? totalCost / turns.completed : null;
  const budgetMonthly = data?.budget.monthly ?? null;
  const budgetPct = budgetMonthly && budgetMonthly > 0 ? projectedMonthly / budgetMonthly : null;

  const memberTurnMap = useMemo(
    () => new Map((data?.memberTurns ?? []).map((m) => [m.userId, m])),
    [data?.memberTurns],
  );

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const hasActivity = !!data && (data.totals.calls > 0 || totalTurns > 0);
  const setFilter = (patch: Partial<Filters>) => {
    setLoading(true);
    setSelectedUser(null);
    setFilters((f) => ({ ...f, ...patch }));
  };
  const resetForReload = () => {
    setLoading(true);
    setSelectedUser(null);
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t(scope === "own" ? "subtitleOwn" : "subtitleShared")}</p>
        </div>
        <ToggleGroup
          value={[String(days)]}
          onValueChange={(v) => {
            if (v.length) {
              resetForReload();
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

      {/* Control bar: whose spend + the rare-dimension filters. */}
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          value={[scope]}
          onValueChange={(v) => {
            if (v.length) {
              resetForReload();
              setScope(v[0] as Scope);
            }
          }}
          variant="outline"
          size="sm"
          className="flex-1"
        >
          {SCOPES.map((s) => (
            <ToggleGroupItem key={s} value={s} className="flex-1">
              {t(s === "own" ? "scopeOwn" : "scopeShared")}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FiltersControl t={t} data={data} filters={filters} setFilter={setFilter} activeCount={activeFilterCount} />
      </div>

      {/* Active filters as removable chips. */}
      {activeFilterCount > 0 && data && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.userId && (
            <Chip label={labelForMember(data, filters.userId)} onClear={() => setFilter({ userId: null })} />
          )}
          {filters.model && <Chip label={filters.model} onClear={() => setFilter({ model: null })} />}
          {filters.projectId && (
            <Chip label={labelForProject(data, filters.projectId)} onClear={() => setFilter({ projectId: null })} />
          )}
          {filters.channel && (
            <Chip label={t(`channel.${filters.channel}`)} onClear={() => setFilter({ channel: null })} />
          )}
          <button
            onClick={() => setFilter(EMPTY_FILTERS)}
            className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("clearFilters")}
          </button>
        </div>
      )}

      {loading ? (
        <UsageSkeleton />
      ) : !hasActivity ? (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          {activeFilterCount > 0 ? t("emptyFiltered") : t("empty")}
        </div>
      ) : (
        <>
          {/* Needs attention — only when at least one trigger fires. */}
          {data.attention.length > 0 && (
            <AttentionBlock t={t} triggers={data.attention} money={money} moneyPrecise={moneyPrecise} pct={pct} />
          )}

          {/* Headline KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={t("spend")}
              value={money(totalCost)}
              delta={<Trend cur={totalCost} prev={data.prev?.cost ?? 0} tone="cost" t={t} pct={pct} />}
              sub={
                budgetPct != null
                  ? t("projectedOfBudget", { cost: money(projectedMonthly), pct: pct(budgetPct) })
                  : t("projectedMonthly", { cost: money(projectedMonthly) })
              }
            />
            <Stat
              label={t("completedTurns")}
              value={num(turns.completed)}
              sub={t("completedTurnsSub", { rate: pct(failRate) })}
            />
            <Stat label={t("activeMembers")} value={num(data.activeMembers)} sub={t("ofWithAccess", { n: data.withAccess })} />
            <Stat
              label={t("costPerTurn")}
              value={costPerTurn == null ? "—" : moneyPrecise(costPerTurn)}
              sub={t("costPerTurnHint")}
            />
          </div>

          {/* Section switch */}
          <ToggleGroup
            value={[tab]}
            onValueChange={(v) => v.length && setTab(v[0] as Tab)}
            variant="outline"
            size="sm"
            className="w-full"
          >
            {TABS.map((tb) => (
              <ToggleGroupItem key={tb} value={tb} className="flex-1">
                {t(`tab.${tb}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {tab === "overview" && (
            <>
              <DailyChart series={data.series} days={data.days} dailyAvg={dailyAvg} money={money} locale={locale} t={t} />

              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("byProject")}</h3>
                <p className="text-xs text-muted-foreground">{t("byProjectHint")}</p>
                <Breakdown
                  rows={data.byProject.map((p) => ({
                    key: p.projectId ?? "__none__",
                    label: <span className="truncate">{p.name ?? t("noProject")}</span>,
                    calls: p.calls,
                    cost: p.cost,
                  }))}
                  total={totalCost}
                  money={money}
                  pct={pct}
                  t={t}
                />
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("byChannel")}</h3>
                <Breakdown
                  rows={data.byChannel.map((c) => ({
                    key: c.channel,
                    label: <span className="truncate">{channelLabel(t, c.channel)}</span>,
                    calls: c.calls,
                    cost: c.cost,
                  }))}
                  total={totalCost}
                  money={money}
                  pct={pct}
                  t={t}
                />
              </section>

              {/* Technical detail — token counts and per-million rates. Collapsed by
                  default: engineer metrics, not what an admin acts on day to day. */}
              <details className="group rounded-lg border">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-2.5 text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                  {t("technicalDetails")}
                  <span className="text-xs text-muted-foreground/70 group-open:hidden">{t("tokensSummary", { tokens: compact(totalTok) })}</span>
                </summary>
                <div className="grid grid-cols-3 gap-3 border-t p-3">
                  <Stat label={t("totalTokens")} value={compact(totalTok)} sub={t("tokenSplit", { input: compact(promptTok), output: compact(outTok) })} />
                  <Stat label={t("cacheRate")} value={pct(cacheRate)} sub={t("cachedTokens", { tokens: compact(cachedTok) })} />
                  <Stat label={t("blendedRate")} value={money(blendedPerM)} sub={t("perMillionTokens")} />
                </div>
              </details>
            </>
          )}

          {tab === "models" && (
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
          )}

          {tab === "people" && (
            <>
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">{t("byUser")}</h3>
                  {data.byUser.length > 8 && (
                    <div className="relative w-44">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder={t("searchUser")} className="h-8 pl-8 text-xs" />
                    </div>
                  )}
                </div>
                <Breakdown
                  rows={data.byUser
                    .filter((u) => {
                      const q = userQuery.trim().toLowerCase();
                      return !q || (u.name || u.email || "").toLowerCase().includes(q);
                    })
                    .map((u) => {
                      const mt = memberTurnMap.get(u.userId);
                      const bits = [
                        u.calls > 0 ? t("userMeta", { cost: moneyPrecise(u.cost / u.calls) }) : null,
                        mt ? t("userTurns", { count: mt.turns }) : null,
                        mt?.lastAt ? t("lastActive", { ago: relativeTime(mt.lastAt, locale) }) : null,
                      ].filter(Boolean);
                      return {
                        key: u.userId,
                        label: <span className="truncate">{u.name || u.email || t("unknownUser")}</span>,
                        meta: bits.length ? bits.join(" · ") : undefined,
                        calls: u.calls,
                        cost: u.cost,
                      };
                    })}
                  total={totalCost}
                  money={money}
                  pct={pct}
                  t={t}
                  selectedKey={selectedUser?.id}
                  onSelect={(key) => {
                    const u = data.byUser.find((x) => x.userId === key);
                    setSelectedUser((cur) => (cur?.id === key ? null : { id: key, name: u?.name || u?.email || t("unknownUser") }));
                  }}
                />
              </section>

              {/* Recent activity (optionally filtered to the selected member) */}
              {data.recent?.length ? (
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium">{t("recentActivity")}</h3>
                    {selectedUser && (
                      <button
                        onClick={() => setSelectedUser(null)}
                        className="flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {selectedUser.name}<X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {(() => {
                    const rows = selectedUser ? data.recent.filter((r) => r.userId === selectedUser.id) : data.recent;
                    if (rows.length === 0) {
                      return <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">{t("noRecentForUser")}</p>;
                    }
                    return (
                      <div className="overflow-hidden rounded-lg border">
                        {rows.map((r, i) => (
                          <RecentItem key={r.id} row={r} money={moneyPrecise} compact={compact} locale={locale} t={t} border={i > 0} />
                        ))}
                      </div>
                    );
                  })()}
                </section>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}

// Channel truth is the parent user message's `platform`; usually one of the three
// known channels, but imported chats carry "import:<source>". Fall back to the raw
// value so an unknown platform renders as itself, never a missing-key error.
function channelLabel(t: T, ch: string) {
  return (CHANNELS as readonly string[]).includes(ch) ? t(`channel.${ch}`) : ch;
}
function labelForMember(data: UsageData, id: string) {
  const m = data.options.members.find((x) => x.id === id);
  return m?.name || id;
}
function labelForProject(data: UsageData, id: string) {
  const p = data.options.projects.find((x) => x.id === id);
  return p?.name || id;
}

/** The "Filters" popover: member / model / project / channel selects. Options are
 *  server-provided and stable across the dimension filters (they ignore them), so
 *  the popover always offers the full set. */
function FiltersControl({
  t,
  data,
  filters,
  setFilter,
  activeCount,
}: {
  t: T;
  data: UsageData | null;
  filters: Filters;
  setFilter: (patch: Partial<Filters>) => void;
  activeCount: number;
}) {
  const opts = data?.options;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors hover:bg-accent/50 disabled:opacity-50",
          activeCount > 0 && "border-primary/50 bg-accent/40",
        )}
        disabled={!opts}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {t("filters")}
        {activeCount > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground tabular-nums">
            {activeCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 space-y-3 p-3">
        <FilterSelect
          label={t("filterMember")}
          value={filters.userId}
          placeholder={t("filterAll")}
          items={(opts?.members ?? []).map((m) => ({ value: m.id, label: m.name || m.id }))}
          onChange={(v) => setFilter({ userId: v })}
        />
        <FilterSelect
          label={t("filterModel")}
          value={filters.model}
          placeholder={t("filterAll")}
          items={(opts?.models ?? []).map((m) => ({ value: m, label: m }))}
          onChange={(v) => setFilter({ model: v })}
        />
        <FilterSelect
          label={t("filterProject")}
          value={filters.projectId}
          placeholder={t("filterAll")}
          items={(opts?.projects ?? []).map((p) => ({ value: p.id, label: p.name || p.id }))}
          onChange={(v) => setFilter({ projectId: v })}
        />
        <FilterSelect
          label={t("filterChannel")}
          value={filters.channel}
          placeholder={t("filterAll")}
          items={CHANNELS.map((c) => ({ value: c, label: t(`channel.${c}`) }))}
          onChange={(v) => setFilter({ channel: v })}
        />
      </PopoverContent>
    </Popover>
  );
}

/** One labeled select in the filters popover. Value "" clears the filter (null).
 *  `items` is passed to the base-ui Select root so the trigger shows the chosen
 *  label, not the raw value. */
function FilterSelect({
  label,
  value,
  placeholder,
  items,
  onChange,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  items: { value: string; label: string }[];
  onChange: (v: string | null) => void;
}) {
  const all = [{ value: "", label: placeholder }, ...items];
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select value={value ?? ""} onValueChange={(v) => onChange((v as string) || null)} items={all}>
        <SelectTrigger className="w-full" size="sm">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {all.map((it) => (
            <SelectItem key={it.value || "__all__"} value={it.value}>
              {it.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A removable active-filter chip. */
function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex items-center gap-1 rounded-full border bg-accent/40 py-0.5 pl-2.5 pr-1 text-xs">
      <span className="max-w-[12rem] truncate">{label}</span>
      <button onClick={onClear} className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground" aria-label="Remove filter">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/** "Needs attention": one calm sentence per fired trigger on a warning surface. */
function AttentionBlock({
  t,
  triggers,
  money,
  moneyPrecise,
  pct,
}: {
  t: T;
  triggers: AttentionTrigger[];
  money: (n: number) => string;
  moneyPrecise: (n: number) => string;
  pct: (n: number) => string;
}) {
  const sentence = (a: AttentionTrigger): string => {
    switch (a.type) {
      case "budget-overrun-projected":
        return t("attn.budgetOverrun", { projected: money(a.projected), budget: money(a.budget) });
      case "member-near-budget":
        return t("attn.memberNearBudget", { name: a.name, used: moneyPrecise(a.used), cap: money(a.cap), pct: pct(a.pct) });
      case "failure-spike":
        return t("attn.failureSpike", { rate: pct(a.rate), prev: pct(a.prevRate), turns: a.turns });
      case "idle-seats":
        return t("attn.idleSeats", { count: a.count, names: a.names.join(", ") });
    }
  };
  return (
    <section
      className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3.5"
      role="status"
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-500">
        <AlertTriangle className="h-3.5 w-3.5" />
        {t("attn.title")}
      </div>
      <ul className="space-y-1 text-sm text-foreground/90">
        {triggers.map((a, i) => (
          <li key={i}>{sentence(a)}</li>
        ))}
      </ul>
    </section>
  );
}

/** Loading shell shaped like the loaded report: KPI grid, section switch, chart, breakdowns. */
function UsageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-8 w-full rounded-lg" />
      <Skeleton className="h-[164px] w-full rounded-lg" />
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-[120px] w-full rounded-lg" />
        </div>
      ))}
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
  onSelect,
  selectedKey,
}: {
  rows: { key: string; label: React.ReactNode; meta?: string; calls: number; cost: number }[];
  total: number;
  money: (n: number) => string;
  pct: (n: number) => string;
  t: T;
  onSelect?: (key: string) => void;
  selectedKey?: string;
}) {
  const max = Math.max(...rows.map((r) => r.cost), 0);
  if (rows.length === 0) {
    return <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">{t("noMatches")}</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      {rows.map((r, i) => {
        const share = total > 0 ? r.cost / total : 0;
        const selected = selectedKey === r.key;
        const Tag = onSelect ? "button" : "div";
        return (
          <Tag
            key={r.key}
            {...(onSelect ? { onClick: () => onSelect(r.key), type: "button" as const } : {})}
            className={cn(
              "relative block w-full px-3.5 py-2.5 text-left",
              i > 0 && "border-t",
              onSelect && "transition-colors hover:bg-accent/40",
              selected && "bg-accent/60",
            )}
          >
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
          </Tag>
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
