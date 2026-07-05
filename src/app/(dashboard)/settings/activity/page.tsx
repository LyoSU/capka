"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  Loader2, ScrollText, UserCog, Puzzle, SlidersHorizontal, ShieldAlert, Dot,
} from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useIsAdmin } from "@/hooks/use-is-admin";

interface Entry {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetKey: string | null;
  detail: Record<string, unknown>;
  createdAt: string | null;
}

type Category = "all" | "people" | "extensions" | "settings" | "security";
const CATEGORIES: Category[] = ["all", "people", "extensions", "settings", "security"];
const PAGE = 50;

// Which coarse group an action belongs to — drives its icon/tint. Mirrors the
// server-side CATEGORY_PREFIXES, but here it's purely presentational.
function groupOf(action: string): Exclude<Category, "all"> {
  if (action.startsWith("user.")) return "people";
  if (action.startsWith("master_key.") || action.startsWith("auth_config.") || action.startsWith("policy.")) return "security";
  if (action.startsWith("settings.") || action.startsWith("billing.")) return "settings";
  return "extensions";
}

const GROUP_ICON: Record<Exclude<Category, "all">, typeof UserCog> = {
  people: UserCog,
  extensions: Puzzle,
  settings: SlidersHorizontal,
  security: ShieldAlert,
};
const GROUP_TINT: Record<Exclude<Category, "all">, string> = {
  people: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  extensions: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  settings: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  security: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

export default function ActivityPage() {
  const t = useTranslations("settings.activity");
  const tp = useTranslations("settings.permissions");
  const locale = useLocale();
  const isAdmin = useIsAdmin();
  const [category, setCategory] = useState<Category>("all");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(async (cat: Category, offset: number) => {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (cat !== "all") q.set("category", cat);
    const res = await fetch(`/api/admin/audit?${q}`);
    if (!res.ok) return { entries: [] as Entry[], hasMore: false };
    return (await res.json()) as { entries: Entry[]; hasMore: boolean };
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetchPage(category, 0).then((d) => {
      if (cancelled) return;
      setEntries(d.entries);
      setHasMore(d.hasMore);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [isAdmin, category, fetchPage]);

  const loadMore = async () => {
    setLoadingMore(true);
    const d = await fetchPage(category, entries.length);
    setEntries((prev) => [...prev, ...d.entries]);
    setHasMore(d.hasMore);
    setLoadingMore(false);
  };

  if (!isAdmin) return <p className="text-sm text-muted-foreground">{t("adminOnly")}</p>;

  // ── Human phrasing helpers ──
  const actionLabel = (action: string) =>
    t.has(`actions.${action}` as never) ? t(`actions.${action}` as never) : action;

  // The thing acted on: prefer a stored human name, fall back to the raw key.
  const targetLabel = (e: Entry): string | null => {
    const d = e.detail || {};
    return (d.name as string) || (d.label as string) || e.targetKey || null;
  };

  // Friendly chips for the values that matter, localized. Unknown detail keys
  // are intentionally not surfaced — the sentence already carries the gist.
  const chips = (e: Entry): string[] => {
    const d = e.detail || {};
    const out: string[] = [];
    if (typeof d.role === "string") out.push(t.has(`role.${d.role}` as never) ? t(`role.${d.role}` as never) : d.role);
    if (typeof d.status === "string") out.push(t.has(`status.${d.status}` as never) ? t(`status.${d.status}` as never) : d.status);
    if (typeof d.effect === "string") out.push(tp(`effect.${d.effect}` as never));
    if (typeof d.mode === "string") out.push(t.has(`mode.${d.mode}` as never) ? t(`mode.${d.mode}` as never) : d.mode);
    if (typeof d.field === "string" && !d.mode) out.push(t.has(`field.${d.field}` as never) ? t(`field.${d.field}` as never) : d.field);
    if (typeof d.scope === "string") out.push(d.scope);
    return out;
  };

  const dayKey = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");
  const dayLabel = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    const today = new Date();
    const yst = new Date(today); yst.setDate(today.getDate() - 1);
    const k = dayKey(iso);
    if (k === dayKey(today.toISOString())) return t("today");
    if (k === dayKey(yst.toISOString())) return t("yesterday");
    return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(d);
  };
  const timeOf = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "";
  const fullTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : "");

  // Group the flat list into day buckets, preserving newest-first order.
  const groups: { day: string; label: string; items: Entry[] }[] = [];
  for (const e of entries) {
    const k = dayKey(e.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === k) last.items.push(e);
    else groups.push({ day: k, label: dayLabel(e.createdAt), items: [e] });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <ToggleGroup
        value={[category]}
        onValueChange={(v) => { if (v.length) { setLoading(true); setCategory(v[0] as Category); } }}
        variant="outline"
        size="sm"
        className="flex-wrap justify-start"
      >
        {CATEGORIES.map((c) => (
          <ToggleGroupItem key={c} value={c}>{t(`category.${c}`)}</ToggleGroupItem>
        ))}
      </ToggleGroup>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <ScrollText className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.day} className="space-y-1.5">
              <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{g.label}</p>
              <div className="overflow-hidden rounded-lg border divide-y">
                {g.items.map((e) => {
                  const grp = groupOf(e.action);
                  const Icon = GROUP_ICON[grp];
                  const target = targetLabel(e);
                  const cs = chips(e);
                  const actor = e.actorName || e.actorEmail || t("systemActor");
                  return (
                    <div key={e.id} className="flex items-start gap-3 px-3 py-2.5">
                      <div className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", GROUP_TINT[grp])}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          {actionLabel(e.action)}
                          {target ? <span className="font-medium"> {target}</span> : null}
                          {cs.map((c) => (
                            <span key={c} className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{c}</span>
                          ))}
                        </p>
                        <p className="mt-0.5 flex items-center text-xs text-muted-foreground">
                          <span className="truncate">{actor}</span>
                          <Dot className="h-3 w-3 shrink-0" />
                          <span className="shrink-0" title={fullTime(e.createdAt)}>{timeOf(e.createdAt)}</span>
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {hasMore && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
