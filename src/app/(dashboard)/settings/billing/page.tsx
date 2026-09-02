"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  SettingsPage,
  SettingsSection,
  SettingsSkeleton,
  SettingsEmpty,
  SettingsError,
  SettingsChoice,
} from "@/components/settings/shell";
import { Loader2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type KeyMode = "shared_plus_own" | "shared_only" | "own_only";
const MODES: KeyMode[] = ["shared_plus_own", "shared_only", "own_only"];

type DefaultTier = {
  limit5h: string | null;
  limitWeek: string | null;
  limitMonth: string | null;
};

export default function BillingPage() {
  const t = useTranslations("settings.billing");
  const tc = useTranslations("common");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [keyMode, setKeyMode] = useState<KeyMode>("shared_plus_own");
  const [savingMode, setSavingMode] = useState(false);

  const [limit5h, setLimit5h] = useState("");
  const [limitWeek, setLimitWeek] = useState("");
  const [limitMonth, setLimitMonth] = useState("");
  const [budgetMonthly, setBudgetMonthly] = useState("");
  const [savingLimits, setSavingLimits] = useState(false);
  // What the server last confirmed, so Save can appear only once a field differs
  // from it — a Save button that is always there is a button that always looks
  // like it has something to do.
  const [saved, setSaved] = useState("");
  const limitsKey = [budgetMonthly, limit5h, limitWeek, limitMonth].map((v) => v.trim()).join("|");
  const limitsDirty = limitsKey !== saved;

  useEffect(() => {
    fetch("/api/admin/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) {
          setLoadError(true);
          return;
        }
        setKeyMode(d.keyMode);
        const dt: DefaultTier = d.defaultTier ?? {};
        setLimit5h(dt.limit5h ?? "");
        setLimitWeek(dt.limitWeek ?? "");
        setLimitMonth(dt.limitMonth ?? "");
        setBudgetMonthly(d.monthlyBudget ?? "");
        setSaved([d.monthlyBudget ?? "", dt.limit5h ?? "", dt.limitWeek ?? "", dt.limitMonth ?? ""].map((v: string) => v.trim()).join("|"));
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const saveMode = async (mode: KeyMode) => {
    setKeyMode(mode); // optimistic
    setSavingMode(true);
    try {
      const res = await fetch("/api/admin/billing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setMode", mode }),
      });
      if (res.ok) toast.success(tc("saved"));
      else toast.error(t("saveFailed"));
    } finally {
      setSavingMode(false);
    }
  };

  const saveLimits = async () => {
    setSavingLimits(true);
    try {
      const res = await fetch("/api/admin/billing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setLimits",
          limit5h: limit5h.trim() || null,
          limitWeek: limitWeek.trim() || null,
          limitMonth: limitMonth.trim() || null,
          budgetMonthly: budgetMonthly.trim() || null,
        }),
      });
      if (res.ok) {
        setSaved(limitsKey);
        toast.success(tc("saved"));
      } else toast.error(t("saveFailed"));
    } finally {
      setSavingLimits(false);
    }
  };

  if (loading) return <SettingsSkeleton />;

  if (loadError) {
    return (
      <SettingsPage title={t("title")} description={t("subtitle")}>
        <SettingsError message={t("loadError")} />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={t("title")} description={t("subtitle")}>
      {/* Provider key mode */}
      <SettingsSection title={t("mode.title")} description={t("mode.desc")}>
        <SettingsChoice
          value={keyMode}
          onChange={saveMode}
          disabled={savingMode}
          label={t("mode.title")}
          options={MODES.map((m) => ({ key: m, label: t(`mode.${m}.label`), hint: t(`mode.${m}.desc`) }))}
        />
      </SettingsSection>

      {/* Default spend limits (shared key only) */}
      <SettingsSection title={t("limits.title")} description={t("limits.desc")}>
        {keyMode === "own_only" ? (
          <SettingsEmpty icon={KeyRound} title={t("limits.ownOnlyTitle")} hint={t("limits.ownOnlyNote")} />
        ) : (
          <>
            {/* Instance-wide monthly budget — the org's whole shared-key bill.
                Drives the analytics overrun trigger and "% of budget" line. */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("budget.label")}</label>
              <div className="relative max-w-[12rem]">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={budgetMonthly}
                  onChange={(e) => setBudgetMonthly(e.target.value)}
                  placeholder={t("budget.placeholder")}
                  className="pl-6"
                />
              </div>
              <p className="text-[13px] text-muted-foreground">{t("budget.hint")}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {([
                ["limit5h", limit5h, setLimit5h, t("limits.window.h5")],
                ["limitWeek", limitWeek, setLimitWeek, t("limits.window.d7")],
                ["limitMonth", limitMonth, setLimitMonth, t("limits.window.m1")],
              ] as const).map(([key, val, set, lbl]) => (
                <div key={key} className="space-y-1.5">
                  <label className="text-sm font-medium">{lbl}</label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={val}
                      onChange={(e) => set(e.target.value)}
                      placeholder="∞"
                      className="pl-6"
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[13px] text-muted-foreground">{t("limits.hint")}</p>
            {limitsDirty && (
              <div className="flex justify-end">
                <Button size="sm" onClick={saveLimits} disabled={savingLimits} className="animate-step-in">
                  {savingLimits && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {tc("save")}
                </Button>
              </div>
            )}
          </>
        )}
      </SettingsSection>
      {/* The per-user tiers section that stood here was an empty state promising
          a feature "soon". A settings page is not a roadmap: a heading with
          nothing under it to decide is one more thing to read and be unsure of. */}
    </SettingsPage>
  );
}
