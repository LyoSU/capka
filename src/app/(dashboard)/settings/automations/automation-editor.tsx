"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AutomationTrigger } from "@/lib/automations/schedule";
import { toForm, toTriggerArgs, type Freq, type ScheduleForm } from "./schedule-form";

export interface EditableAutomation {
  id: string;
  title: string;
  prompt: string;
  trigger: AutomationTrigger;
  /** The full callable address of a webhook automation, or null. Built by the
   *  list route from the instance's public origin — never re-derived here, so a
   *  tab open on some other hostname can't hand out an unreachable URL. */
  webhookUrl: string | null;
  maxRunsPerDay: number | null;
  threadMode: string;
  /** "always" (every run reports) or "when_needed" (a monitor: a run that found
   *  nothing worth saying ends without a message, a notification or an unread mark). */
  notifyMode: string;
  /** Whether runs are pushed to the owner's Telegram. Orthogonal to notifyMode:
   *  that decides WHEN a run has something to say, this WHERE it lands. */
  deliverTelegram: boolean;
  /** The condition sentence checked before each run, or null when every firing
   *  runs. Empty text and null mean the same thing to the server. */
  runWhen: string | null;
}

export function AutomationEditor({
  automation, open, telegramLinked, onClose, onSaved,
}: {
  /** null with `open` means "new one" — the same form, seeded with a plain
   *  daily-at-09:00 schedule, because creating and editing ask for exactly the
   *  same four things. */
  automation: EditableAutomation | null;
  open?: boolean;
  /** Whether the owner has Telegram connected at all. The delivery switch is a
   *  real choice only then; without a link it would be a control with no effect,
   *  so it is not shown. Resolved by the list route, not fetched again here. */
  telegramLinked?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("settings.automations");
  // Keyed remount from the parent gives every automation a fresh form, so this
  // can seed straight from props without an effect syncing them afterwards.
  const [title, setTitle] = useState(automation?.title ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? "");
  const [schedule, setSchedule] = useState<ScheduleForm>(() =>
    toForm(
      automation?.trigger ?? { kind: "schedule", cron: "0 9 * * *", timezone: "" },
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ));
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [threadMode, setThreadMode] = useState(automation?.threadMode === "single" ? "single" : "fresh");
  const [notifyMode, setNotifyMode] = useState(automation?.notifyMode === "when_needed" ? "when_needed" : "always");
  // Absent on a NEW automation, and the default is on — the same bargain the row
  // default strikes, so creating one in the UI matches creating one in chat.
  const [deliverTelegram, setDeliverTelegram] = useState(automation?.deliverTelegram !== false);
  // Kept as the raw text of the field: empty means "no limit", and coercing to a
  // number here would turn a half-typed value into a saved one.
  const [maxRuns, setMaxRuns] = useState(automation?.maxRunsPerDay ? String(automation.maxRunsPerDay) : "");
  const [runWhen, setRunWhen] = useState(automation?.runWhen ?? "");
  const [webhookUrl, setWebhookUrl] = useState(automation?.webhookUrl ?? null);
  const [rotating, setRotating] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!automation && !open) return null;

  const patchSchedule = (patch: Partial<ScheduleForm>) => {
    setScheduleTouched(true);
    setSchedule((s) => ({ ...s, ...patch }));
  };

  const limit = Number(maxRuns);
  const validLimit = maxRuns.trim() === "" ? null : Number.isInteger(limit) && limit >= 1 && limit <= 1000 ? limit : undefined;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(
        automation ? `/api/automations/${automation.id}` : "/api/automations",
        {
          method: automation ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            prompt: prompt.trim(),
            thread_mode: threadMode,
            notify_mode: notifyMode,
            deliver_telegram: deliverTelegram,
            // Emptying the field REMOVES the condition, so an edit always sends
            // the value (null when blank); on create a blank one is simply left
            // out, the same bargain the run limit above strikes.
            ...(runWhen.trim() ? { run_when: runWhen.trim() } : automation ? { run_when: null } : {}),
            // "No limit" is `null` on an edit (clearing the field has to be able
            // to REMOVE a limit) but simply absent on create, where the field has
            // never held a value to clear.
            ...(validLimit !== null ? { max_runs_per_day: validLimit } : automation ? { max_runs_per_day: null } : {}),
            // On edit, an untouched custom schedule is left out of the body
            // entirely — sending it back through the simple builder would flatten
            // an expression this editor never claimed to understand. On create
            // there is always a schedule to send.
            ...(!automation || (scheduleTouched && schedule.freq !== "custom") ? toTriggerArgs(schedule) : {}),
          }),
        });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error || t("saveFailed"));
        return;
      }
      toast.success(automation ? t("saved") : t("created"));
      onSaved();
      onClose();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const weekdayItems = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [String(i), t(`weekday.w${i}`)]),
  );
  const monthDayItems = Object.fromEntries(
    Array.from({ length: 28 }, (_, i) => [String(i + 1), String(i + 1)]),
  );
  const canSave = title.trim().length > 0 && prompt.trim().length > 0 &&
    (schedule.freq !== "once" || schedule.at.length >= 16) && validLimit !== undefined;

  const copyUrl = async () => {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast.success(t("webhook.copied"));
    } catch {
      toast.error(t("webhook.copyFailed"));
    }
  };

  // Rotating retires the old address immediately, so the replacement comes back
  // in the response and lands in this open dialog — closing to reload the list
  // would hand someone a dead URL and no way to read the new one.
  const rotate = async () => {
    if (!automation) return;
    setRotating(true);
    try {
      const res = await fetch(`/api/automations/${automation.id}/rotate-token`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.webhookUrl) {
        toast.error(body?.error || t("webhook.rotateFailed"));
        return;
      }
      setWebhookUrl(body.webhookUrl);
      toast.success(t("webhook.rotated"));
    } catch {
      toast.error(t("webhook.rotateFailed"));
    } finally {
      setRotating(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85dvh] w-full flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="gap-1 border-b px-4 py-3 pr-12">
          <DialogTitle className="truncate">{automation ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription className="truncate">
            {automation ? automation.title : t("createHint")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pt-4 pb-8 [scrollbar-gutter:stable]">
          {/* `flex flex-col`, not `space-y`: a bare <label> is inline, so it
              would share a line with anything that isn't a block box — which is
              exactly what an <Input> (inline-block) is. Flex items are
              blockified, so the label always sits above its control. */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="automation-title" className="text-sm font-medium">{t("nameLabel")}</label>
            <Input id="automation-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="automation-prompt" className="text-sm font-medium">{t("promptLabel")}</label>
            <Textarea
              id="automation-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={7}
              className="resize-y"
            />
            <p className="text-xs text-muted-foreground">{t("promptHint")}</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("scheduleLabel")}</p>

            {schedule.freq === "custom" && !scheduleTouched && (
              <div className="space-y-1.5 rounded-xl bg-muted px-4 py-3">
                <p className="font-mono text-xs">{schedule.cron}</p>
                <p className="text-xs text-muted-foreground">{t("customScheduleHint")}</p>
              </div>
            )}

            <ToggleGroup
              value={[schedule.freq === "custom" ? "" : schedule.freq]}
              onValueChange={(v) => v.length && patchSchedule({ freq: v[0] as Freq })}
              variant="outline"
              size="sm"
              className="flex-wrap justify-start"
            >
              <ToggleGroupItem value="daily">{t("freq.daily")}</ToggleGroupItem>
              <ToggleGroupItem value="weekly">{t("freq.weekly")}</ToggleGroupItem>
              <ToggleGroupItem value="monthly">{t("freq.monthly")}</ToggleGroupItem>
              <ToggleGroupItem value="once">{t("freq.once")}</ToggleGroupItem>
              <ToggleGroupItem value="webhook">{t("freq.webhook")}</ToggleGroupItem>
            </ToggleGroup>

            {schedule.freq !== "custom" && schedule.freq !== "webhook" && (
              <div className="flex flex-wrap items-end gap-3 pt-1">
                {schedule.freq === "once" ? (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="automation-at" className="text-xs text-muted-foreground">{t("dateLabel")}</label>
                    <Input
                      id="automation-at"
                      type="datetime-local"
                      value={schedule.at}
                      onChange={(e) => patchSchedule({ at: e.target.value })}
                      className="w-56"
                    />
                  </div>
                ) : (
                  <>
                    {schedule.freq === "weekly" && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">{t("weekdayLabel")}</label>
                        <Select
                          value={schedule.weekday}
                          onValueChange={(v) => v && patchSchedule({ weekday: v as string })}
                          items={weekdayItems}
                        >
                          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(weekdayItems).map(([k, label]) => (
                              <SelectItem key={k} value={k}>{label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {schedule.freq === "monthly" && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs text-muted-foreground">{t("dayOfMonthLabel")}</label>
                        <Select
                          value={schedule.dayOfMonth}
                          onValueChange={(v) => v && patchSchedule({ dayOfMonth: v as string })}
                          items={monthDayItems}
                        >
                          <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Object.keys(monthDayItems).map((k) => (
                              <SelectItem key={k} value={k}>{k}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="automation-time" className="text-xs text-muted-foreground">{t("timeLabel")}</label>
                      <Input
                        id="automation-time"
                        type="time"
                        value={schedule.time}
                        onChange={(e) => patchSchedule({ time: e.target.value })}
                        className="w-28"
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {schedule.freq === "webhook" && (
              <div className="space-y-2 pt-1">
                <p className="text-xs text-muted-foreground">{t("webhook.hint")}</p>
                {webhookUrl ? (
                  <>
                    <div className="flex items-center gap-2">
                      {/* Read-only and selectable rather than a styled block: the
                          only thing anyone does with this is copy it, and a real
                          input is what makes select-all work on every platform. */}
                      <Input readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
                      <Button variant="outline" size="icon" className="shrink-0" onClick={copyUrl} aria-label={t("webhook.copy")} title={t("webhook.copy")}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("webhook.secretWarning")}</p>
                    <Button variant="ghost" size="sm" onClick={rotate} disabled={rotating}>
                      {rotating
                        ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                      {t("webhook.rotate")}
                    </Button>
                    <p className="text-xs text-muted-foreground">{t("webhook.rotateHint")}</p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("webhook.pendingSave")}</p>
                )}
              </div>
            )}

            {/* Which clock the time above is read in. Without this line "09:00"
                is ambiguous the moment someone travels or the instance is hosted
                elsewhere — and the trigger keeps its own zone, not the reader's.
                A webhook has no time to read, but the same zone still decides
                which calendar day its run limit counts against — so it says so
                rather than showing a note about times that don't exist. */}
            <p className="text-xs text-muted-foreground">
              {schedule.freq === "webhook" ? t("webhook.tzNote", { tz: schedule.timezone }) : t("tzNote", { tz: schedule.timezone })}
            </p>
          </div>

          {/* Directly under the schedule, because it qualifies it: the schedule
              says WHEN a firing happens, this says whether that firing is worth
              running. Optional and empty by default — an automation with no
              condition never pays for a gate call. */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="automation-run-when" className="text-sm font-medium">{t("runWhen.label")}</label>
            <Textarea
              id="automation-run-when"
              value={runWhen}
              onChange={(e) => setRunWhen(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder={t("runWhen.placeholder")}
              className="resize-y"
            />
            <p className="text-xs text-muted-foreground">{t("runWhen.hint")}</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("threadModeLabel")}</p>
            <ToggleGroup
              value={[threadMode]}
              onValueChange={(v) => v.length && setThreadMode(v[0] as string)}
              variant="outline"
              size="sm"
              className="flex-wrap justify-start"
            >
              <ToggleGroupItem value="fresh">{t("threadMode.fresh")}</ToggleGroupItem>
              <ToggleGroupItem value="single">{t("threadMode.single")}</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {threadMode === "single" ? t("threadMode.singleHint") : t("threadMode.freshHint")}
            </p>
          </div>

          {/* Directly under the thread mode, because the two are read together:
              "only when there is something to report" means comparing this run
              with the last one, which is what one ongoing chat gives the agent. */}
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("notifyModeLabel")}</p>
            <ToggleGroup
              value={[notifyMode]}
              onValueChange={(v) => v.length && setNotifyMode(v[0] as string)}
              variant="outline"
              size="sm"
              className="flex-wrap justify-start"
            >
              <ToggleGroupItem value="always">{t("notifyMode.always")}</ToggleGroupItem>
              <ToggleGroupItem value="when_needed">{t("notifyMode.whenNeeded")}</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {notifyMode === "when_needed" ? t("notifyMode.whenNeededHint") : t("notifyMode.alwaysHint")}
            </p>
          </div>

          {/* Under the notify toggle because the two read as one question with two
              halves — when a run speaks, and where. Shown only to someone who has
              Telegram connected: without a link this switch changes nothing, and a
              control with no effect is worse than no control. */}
          {telegramLinked && (
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="automation-telegram" className="text-sm font-medium">{t("deliverTelegramLabel")}</label>
                <p className="text-xs text-muted-foreground">{t("deliverTelegramHint")}</p>
              </div>
              <Switch
                id="automation-telegram"
                checked={deliverTelegram}
                onCheckedChange={setDeliverTelegram}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="automation-max-runs" className="text-sm font-medium">{t("maxRunsLabel")}</label>
            <Input
              id="automation-max-runs"
              type="number"
              min={1}
              max={1000}
              value={maxRuns}
              onChange={(e) => setMaxRuns(e.target.value)}
              placeholder={t("maxRunsPlaceholder")}
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">{t("maxRunsHint")}</p>
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving || !canSave}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
