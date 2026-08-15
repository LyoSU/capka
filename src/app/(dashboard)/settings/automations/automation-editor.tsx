"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AutomationTrigger } from "@/lib/automations/schedule";
import { toForm, toTriggerArgs, type Freq, type ScheduleForm } from "./schedule-form";

export interface EditableAutomation {
  id: string;
  title: string;
  prompt: string;
  trigger: AutomationTrigger;
}

export function AutomationEditor({
  automation, open, onClose, onSaved,
}: {
  /** null with `open` means "new one" — the same form, seeded with a plain
   *  daily-at-09:00 schedule, because creating and editing ask for exactly the
   *  same four things. */
  automation: EditableAutomation | null;
  open?: boolean;
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
  const [saving, setSaving] = useState(false);

  if (!automation && !open) return null;

  const patchSchedule = (patch: Partial<ScheduleForm>) => {
    setScheduleTouched(true);
    setSchedule((s) => ({ ...s, ...patch }));
  };

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
    (schedule.freq !== "once" || schedule.at.length >= 16);

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
              <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
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
            </ToggleGroup>

            {schedule.freq !== "custom" && (
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

            {/* Which clock the time above is read in. Without this line "09:00"
                is ambiguous the moment someone travels or the instance is hosted
                elsewhere — and the trigger keeps its own zone, not the reader's. */}
            <p className="text-xs text-muted-foreground">{t("tzNote", { tz: schedule.timezone })}</p>
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
