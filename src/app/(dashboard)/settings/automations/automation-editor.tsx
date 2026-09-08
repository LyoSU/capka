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
  enabled: boolean;
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

/** "Europe/Kyiv (GMT+3)" — the offset is what lets someone tell two zones with
 *  the same city-less name apart, and it is read at the current instant so DST
 *  shows the offset that applies today. */
function zoneLabel(tz: string): string {
  try {
    const offset = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return offset ? `${tz} (${offset})` : tz;
  } catch {
    return tz;
  }
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
  // Only an existing automation has a switch: creation has no `enabled` to send
  // (a new one is always on), so the header shows one on edit alone.
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [schedule, setSchedule] = useState<ScheduleForm>(() =>
    toForm(
      automation?.trigger ?? { kind: "schedule", cron: "0 9 * * *", timezone: "" },
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ));
  const [scheduleTouched, setScheduleTouched] = useState(false);
  // The zone is the browser's unless the row already has one, and almost no one
  // needs to change it — so the picker stays folded behind one link until asked.
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [pickingZone, setPickingZone] = useState(false);
  // The zone list is built once per dialog: ~400 Intl lookups is cheap on mount
  // and pointless on every render. A stored zone Intl no longer lists (an alias
  // like Europe/Kiev) is kept at the top so the picker never shows a blank value.
  const [zones] = useState<Record<string, string>>(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    const current = automation?.trigger.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!all.includes(current)) all.unshift(current);
    return Object.fromEntries(all.map((z) => [z, zoneLabel(z)]));
  });
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
            // Sent only when the switch actually moved: `enabled: true` on the
            // server also recomputes the run horizon, which an unrelated edit of
            // an already-active automation must not trigger.
            ...(automation && enabled !== automation.enabled ? { enabled } : {}),
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

  const freqItems = Object.fromEntries(
    (["daily", "weekly", "monthly", "once", "webhook"] as Freq[]).map((f) => [f, t(`freq.${f}`)]),
  );
  // Monday first: cron counts from Sunday, but nobody's week does.
  const weekdayOrder = ["1", "2", "3", "4", "5", "6", "0"];
  const monthDayItems = Object.fromEntries(
    Array.from({ length: 28 }, (_, i) => [String(i + 1), String(i + 1)]),
  );
  const canSave = title.trim().length > 0 && prompt.trim().length > 0 &&
    (schedule.freq !== "once" || schedule.at.length >= 16) &&
    (schedule.freq !== "weekly" || schedule.weekdays.length > 0) && validLimit !== undefined;

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
        {/* One row: the title, and — on edit — the enabled switch at the far
            end, where the eye looks for "is this thing on". The subtitle is
            for screen readers only; sighted users get the form itself. */}
        <DialogHeader className="flex-row items-center justify-between gap-4 border-b px-5 py-3.5 pr-12">
          <DialogTitle className="truncate">{automation ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription className="sr-only">
            {automation ? automation.title : t("createHint")}
          </DialogDescription>
          {automation && (
            <label className="flex shrink-0 items-center gap-2.5 text-sm text-muted-foreground">
              {t("enabledLabel")}
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </label>
          )}
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-5 pt-4 pb-6 [scrollbar-gutter:stable]">
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
              rows={5}
              className="resize-y"
            />
            <p className="text-xs text-muted-foreground">{t("promptHint")}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">{t("scheduleLabel")}</p>

            {schedule.freq === "custom" && !scheduleTouched && (
              <div className="mb-1 space-y-1 rounded-xl bg-muted px-4 py-3">
                <p className="font-mono text-xs">{schedule.cron}</p>
                <p className="text-xs text-muted-foreground">{t("customScheduleHint")}</p>
              </div>
            )}

            {/* The whole schedule reads as one sentence — "weekly, at 09:00, on
                Monday" — so it is laid out as one row, and each control names
                itself for assistive tech instead of carrying a visible label. */}
            <div className="flex flex-wrap gap-2">
              <Select
                value={schedule.freq === "custom" ? null : schedule.freq}
                onValueChange={(v) => v && patchSchedule({ freq: v as Freq })}
                items={freqItems}
              >
                <SelectTrigger className="min-w-36 flex-1" aria-label={t("scheduleLabel")}>
                  <SelectValue placeholder={t("freqPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(freqItems).map(([k, label]) => (
                    <SelectItem key={k} value={k}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {schedule.freq === "once" && (
                <Input
                  type="datetime-local"
                  aria-label={t("dateLabel")}
                  value={schedule.at}
                  onChange={(e) => patchSchedule({ at: e.target.value })}
                  className="w-auto min-w-52 flex-1"
                />
              )}

              {(schedule.freq === "daily" || schedule.freq === "weekly" || schedule.freq === "monthly") && (
                <Input
                  type="time"
                  aria-label={t("timeLabel")}
                  value={schedule.time}
                  onChange={(e) => patchSchedule({ time: e.target.value })}
                  className="w-28"
                />
              )}

              {schedule.freq === "monthly" && (
                <Select
                  value={schedule.dayOfMonth}
                  onValueChange={(v) => v && patchSchedule({ dayOfMonth: v as string })}
                  items={monthDayItems}
                >
                  <SelectTrigger className="min-w-24 flex-1" aria-label={t("dayOfMonthLabel")}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.keys(monthDayItems).map((k) => (
                      <SelectItem key={k} value={k}>{k}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* One pill per day, several at once: "Mon–Fri at 09:00" is the
                commonest weekly schedule and a single-day picker made it five
                automations. Full day names go to assistive tech via aria-label. */}
            {schedule.freq === "weekly" && (
              <ToggleGroup
                multiple
                value={schedule.weekdays}
                onValueChange={(v) => patchSchedule({ weekdays: (v as string[]).slice().sort() })}
                variant="outline"
                size="sm"
                spacing={1.5}
                aria-label={t("weekdayLabel")}
                className="flex-wrap pt-1"
              >
                {weekdayOrder.map((d) => (
                  <ToggleGroupItem key={d} value={d} aria-label={t(`weekday.w${d}`)} className="min-w-11 px-2.5">
                    {t(`weekdayShort.w${d}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
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
                        <Copy />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("webhook.secretWarning")}</p>
                    <Button variant="ghost" size="sm" onClick={rotate} disabled={rotating}>
                      {rotating
                        ? <Loader2 className="animate-spin" />
                        : <RefreshCw />}
                      {t("webhook.rotate")}
                    </Button>
                    <p className="text-xs text-muted-foreground">{t("webhook.rotateHint")}</p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("webhook.pendingSave")}</p>
                )}
              </div>
            )}
          </div>

          {/* Which clock the time above is read in. Without this "09:00" is
              ambiguous the moment someone travels or the instance is hosted
              elsewhere — and the trigger keeps its own zone, not the reader's.
              A webhook has no time to read, but the same zone still decides
              which calendar day its run limit counts against — so it says so.
              Folded to one line by default; a zone that is not the browser's
              gets a one-click way back to it, which is the common fix. */}
          <div className="flex flex-col gap-1.5">
            {pickingZone ? (
              <>
                <label htmlFor="automation-timezone" className="text-sm font-medium">{t("timezoneLabel")}</label>
                <Select
                  value={schedule.timezone}
                  onValueChange={(v) => v && patchSchedule({ timezone: v as string })}
                  items={zones}
                >
                  <SelectTrigger id="automation-timezone" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(zones).map(([k, label]) => (
                      <SelectItem key={k} value={k}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {schedule.freq === "webhook"
                  ? t("webhook.tzNote", { tz: zoneLabel(schedule.timezone) })
                  : t("tzNote", { tz: zoneLabel(schedule.timezone) })}
                {" · "}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setPickingZone(true)}>
                  {t("tzChange")}
                </button>
              </p>
            )}
            {schedule.timezone !== browserTz && (
              <div>
                <Button variant="outline" size="sm" onClick={() => patchSchedule({ timezone: browserTz })}>
                  {t("tzUseMine", { tz: browserTz })}
                </Button>
              </div>
            )}
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

          {/* Everything above decides when a run happens; everything below,
              what becomes of it. The rule marks that turn. */}
          <hr className="border-border" />

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
            <div className="flex items-center justify-between gap-4">
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

        <div className="flex shrink-0 justify-end gap-2 border-t px-5 py-3.5">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving || !canSave}>
            {saving && <Loader2 className="animate-spin" />}
            {automation ? t("save") : t("create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
