"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, ExternalLink, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { AutomationTrigger } from "@/lib/automations/schedule";

interface Automation {
  id: string;
  title: string;
  prompt: string;
  trigger: AutomationTrigger;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  lastChatId: string | null;
}

type Status = "active" | "paused" | "autoPaused";

const AUTO_PAUSE_THRESHOLD = 3;

function statusOf(a: Automation): Status {
  if (a.enabled) return "active";
  return a.consecutiveFailures >= AUTO_PAUSE_THRESHOLD ? "autoPaused" : "paused";
}

export default function AutomationsList() {
  const t = useTranslations("settings.automations");
  const locale = useLocale();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const res = await fetch("/api/automations");
      if (res.ok) setAutomations((await res.json()).automations ?? []);
      else setError(t("loadError"));
    } catch {
      setError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (a: Automation, enabled: boolean) => {
    const prev = automations;
    setAutomations((list) => list.map((x) => (x.id === a.id ? { ...x, enabled } : x)));
    const res = await fetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      setAutomations(prev);
      toast.error(t("toggleFailed"));
    }
  };

  const remove = async (a: Automation) => {
    const prev = automations;
    setAutomations((list) => list.filter((x) => x.id !== a.id));
    const res = await fetch(`/api/automations/${a.id}`, { method: "DELETE" });
    if (res.ok) toast.success(t("deleted", { name: a.title }));
    else {
      setAutomations(prev);
      toast.error(t("deleteFailed"));
    }
  };

  // The scheduler ticks every 30s; a next_run_at more than this far in the past on
  // an ENABLED automation means the worker isn't firing (crashed / not running) —
  // surface it instead of recomputing a fake future date that hides the outage.
  const OVERDUE_GRACE_MS = 2 * 60_000;
  const isOverdue = (a: Automation) =>
    a.enabled && !!a.nextRunAt && Date.now() - Date.parse(a.nextRunAt) > OVERDUE_GRACE_MS;

  const nextRunText = (a: Automation) => {
    // Show the ACTUAL next_run_at the scheduler stored — not a client-side cron
    // recompute, which would mask a stuck worker (and, for a one-off, silently
    // re-derive the wall time in the browser's zone instead of the trigger's).
    if (!a.enabled || !a.nextRunAt || isOverdue(a)) return null;
    const fmt = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: a.trigger.timezone,
    });
    return t("nextRun", { when: fmt.format(new Date(a.nextRunAt)) });
  };

  const lastRunText = (a: Automation) => {
    if (a.enabled || !a.lastRunAt) return null;
    const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
    return t("lastRun", { when: fmt.format(new Date(a.lastRunAt)) });
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-[4.5rem] animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>;
  }

  if (automations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
          <CalendarClock className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="mx-auto max-w-xs text-sm text-muted-foreground">{t("emptyHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {automations.map((a) => {
        const status = statusOf(a);
        return (
          <div key={a.id} className="flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/15">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/70">
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{a.title}</span>
                {status === "active" && (
                  <Badge variant="secondary" className="bg-success/10 font-normal text-success">
                    {t("status.active")}
                  </Badge>
                )}
                {status === "paused" && (
                  <Badge variant="secondary" className="font-normal text-muted-foreground">
                    {t("status.paused")}
                  </Badge>
                )}
                {status === "autoPaused" && (
                  <Badge variant="outline" className="gap-1 border-warning-border font-normal text-warning-text">
                    <AlertTriangle className="h-3 w-3" /> {t("status.autoPaused")}
                  </Badge>
                )}
                {status === "active" && isOverdue(a) && (
                  <Badge variant="outline" className="gap-1 border-warning-border font-normal text-warning-text">
                    <AlertTriangle className="h-3 w-3" /> {t("status.overdue")}
                  </Badge>
                )}
              </div>
              <p className="truncate text-sm text-muted-foreground">{a.prompt}</p>
              {isOverdue(a) ? (
                <p className="text-xs text-warning-text">{t("overdueHint")}</p>
              ) : (nextRunText(a) || lastRunText(a)) ? (
                <p className="text-xs text-muted-foreground">{nextRunText(a) ?? lastRunText(a)}</p>
              ) : null}
              {a.lastChatId && (
                <Link href={`/chat/${a.lastChatId}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
                  <ExternalLink className="h-3 w-3" /> {t("openLastRun")}
                </Link>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Switch checked={a.enabled} onCheckedChange={(v) => toggle(a, v)} aria-label={t("toggleAria", { name: a.title })} />
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={t("deleteAria", { name: a.title })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("deleteTitle", { name: a.title })}</AlertDialogTitle>
                    <AlertDialogDescription>{t("deleteWarn")}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => remove(a)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                      {t("delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        );
      })}
    </div>
  );
}
