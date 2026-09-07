"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, ExternalLink, Pencil, Play, Plus, Trash2, Webhook } from "lucide-react";
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
import { SettingsEmpty, SettingsError } from "@/components/settings/shell";
import type { AutomationTrigger } from "@/lib/automations/schedule";
import { Skeleton } from "@/components/ui/skeleton";
import { relTime } from "../users/format";
import { AutomationEditor } from "./automation-editor";

interface Automation {
  id: string;
  title: string;
  prompt: string;
  trigger: AutomationTrigger;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  /** In `single` thread mode this is the ongoing thread; otherwise the chat the
   *  last run opened. Resolved server-side — see the list route. */
  lastChatId: string | null;
  webhookUrl: string | null;
  maxRunsPerDay: number | null;
  /** Both counters are already scoped to the owner's local TODAY by the list
   *  route; a stamped day in the past arrives here as zero. */
  runsToday: number;
  skippedToday: number;
  /** Runs that happened today and deliberately said nothing (notify mode
   *  "when_needed"). Day-scoped by the list route, like the two above. */
  quietToday: number;
  threadMode: string;
  /** "always" or "when_needed" — whether every run reports, or only the ones
   *  that found something. */
  notifyMode: string;
  /** Whether runs are pushed to Telegram at all. */
  deliverTelegram: boolean;
  /** The condition checked before each run, or null when every firing runs. */
  runWhen: string | null;
  /** The LAST skip and why — not scoped to today, on purpose: "why has this been
   *  quiet" is asked exactly when the answer is older than today. */
  lastSkip: { reason: "daily_limit" | "busy" | "condition"; at: string; note?: string } | null;
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
  const router = useRouter();
  const [automations, setAutomations] = useState<Automation[]>([]);
  // Handed down to the editor, which uses it to decide whether the Telegram
  // delivery switch is a real choice. Comes with the list rather than from a
  // second fetch — see the route.
  const [telegramLinked, setTelegramLinked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Automation | null>(null);
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError("");
      const res = await fetch("/api/automations");
      if (res.ok) {
        const body = await res.json();
        setAutomations(body.automations ?? []);
        setTelegramLinked(!!body.telegramLinked);
      } else setError(t("loadError"));
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

  // Run once now, off-schedule. The whole point is being able to check what an
  // automation does without waiting for its next occurrence, so a successful run
  // hands the user the chat it opened rather than a toast about a chat elsewhere.
  const runNow = async (a: Automation) => {
    setRunning(a.id);
    try {
      const res = await fetch(`/api/automations/${a.id}/run`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.chatId) {
        toast.success(t("runStarted"));
        router.push(`/chat/${body.chatId}`);
        return;
      }
      // 409 means the previous run is still working or waiting on an answer —
      // that's a state to explain, not an error to apologize for.
      toast.error(res.status === 409 ? t("runBusy") : t("runFailed"));
    } catch {
      toast.error(t("runFailed"));
    } finally {
      setRunning(null);
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
    // A webhook has no next time at all, and saying "runs on a web address" is
    // what stops an empty line reading as a broken or paused automation.
    if (a.trigger.kind === "webhook") return a.enabled ? t("onWebhook") : null;
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
          <Skeleton key={i} className="h-[4.5rem] rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) return <SettingsError message={error} />;

  const editor = (
    // Keyed so switching between automations rebuilds the form from the new row
    // instead of carrying the previous one's draft across; "new" is its own key.
    <AutomationEditor
      key={editing?.id ?? (creating ? "new" : "closed")}
      automation={editing}
      open={creating}
      telegramLinked={telegramLinked}
      onClose={() => { setEditing(null); setCreating(false); }}
      onSaved={load}
    />
  );

  if (automations.length === 0) {
    return (
      <>
        <SettingsEmpty
          icon={CalendarClock}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
          action={<Button size="sm" onClick={() => setCreating(true)}><Plus className="mr-1 h-3.5 w-3.5" />{t("create")}</Button>}
        />
        {editor}
      </>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />{t("create")}
        </Button>
      </div>
      {automations.map((a) => {
        const status = statusOf(a);
        return (
          <div key={a.id} className="flex items-start gap-3 border-t py-4">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/70">
              {/* The icon carries the trigger kind, so a list of both reads at a
                  glance without every row spelling it out in words. */}
              {a.trigger.kind === "webhook"
                ? <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                : <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />}
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
              {/* The condition belongs in the subtitle, next to the instruction:
                  a row that reads "runs daily" while quietly refusing most of its
                  firings is the one thing this list must not imply. */}
              {a.runWhen && (
                <p className="truncate text-xs text-muted-foreground">{t("runWhen.rowLabel", { condition: a.runWhen })}</p>
              )}
              {isOverdue(a) ? (
                <p className="text-xs text-warning-text">{t("overdueHint")}</p>
              ) : (nextRunText(a) || lastRunText(a)) ? (
                <p className="text-xs text-muted-foreground">{nextRunText(a) ?? lastRunText(a)}</p>
              ) : null}
              {/* An automation the platform switched off has to say why and what
                  to do about it — a grey badge over a dead switch leaves the user
                  guessing whether to flip it back or fix something first. */}
              {status === "autoPaused" && (
                <p className="text-xs text-warning-text">{t("autoPausedHint")}</p>
              )}
              {/* A cap that refused runs today has to SAY so. Silently skipping
                  is indistinguishable from a worker that stopped firing, which is
                  the thing the "Not running" badge above exists to warn about. */}
              {a.maxRunsPerDay !== null && a.skippedToday > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("dailyLimitSkipped", { skipped: a.skippedToday, max: a.maxRunsPerDay })}
                </p>
              )}
              {/* A monitor that has been quiet all day has to say so. Without
                  this line "no messages" reads as a scheduler that stopped
                  firing — which is the one thing a monitor must never look like. */}
              {a.quietToday > 0 && (
                <p className="text-xs text-muted-foreground">{t("quietToday", { n: a.quietToday })}</p>
              )}
              {/* One calm line: WHEN it last declined to run and WHY. A counter
                  alone cannot answer "why is this quiet", and neither can an
                  empty row — which is what someone reads as a broken worker. */}
              {a.lastSkip && (
                <p className="text-xs text-muted-foreground">
                  {t("skipped", {
                    when: relTime(locale, a.lastSkip.at),
                    reason: t(`skipReason.${a.lastSkip.reason}`),
                  })}
                </p>
              )}
              {a.lastChatId && (
                <Link href={`/chat/${a.lastChatId}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
                  <ExternalLink className="h-3 w-3" /> {a.threadMode === "single" ? t("openThread") : t("openLastRun")}
                </Link>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {/* Run and edit sit before the switch: they are what someone came to
                  do with an automation, while the switch is what they do to it. */}
              <Button
                variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground"
                onClick={() => runNow(a)} disabled={running === a.id}
                aria-label={t("runAria", { name: a.title })} title={t("runNow")}
              >
                <Play className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground"
                onClick={() => setEditing(a)}
                aria-label={t("editAria", { name: a.title })} title={t("edit")}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Switch checked={a.enabled} onCheckedChange={(v) => toggle(a, v)} aria-label={t("toggleAria", { name: a.title })} />
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={t("deleteAria", { name: a.title })}>
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

      {editor}
    </div>
  );
}
