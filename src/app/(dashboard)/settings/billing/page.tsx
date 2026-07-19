"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

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
  const [keyMode, setKeyMode] = useState<KeyMode>("shared_plus_own");
  const [savingMode, setSavingMode] = useState(false);

  const [limit5h, setLimit5h] = useState("");
  const [limitWeek, setLimitWeek] = useState("");
  const [limitMonth, setLimitMonth] = useState("");
  const [budgetMonthly, setBudgetMonthly] = useState("");
  const [savingLimits, setSavingLimits] = useState(false);

  useEffect(() => {
    fetch("/api/admin/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setKeyMode(d.keyMode);
        const dt: DefaultTier = d.defaultTier ?? {};
        setLimit5h(dt.limit5h ?? "");
        setLimitWeek(dt.limitWeek ?? "");
        setLimitMonth(dt.limitMonth ?? "");
        setBudgetMonthly(d.monthlyBudget ?? "");
      })
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
      if (res.ok) toast.success(tc("saved"));
      else toast.error(t("saveFailed"));
    } finally {
      setSavingLimits(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      {/* Provider key mode */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t("mode.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("mode.desc")}</p>
        </div>
        <div className="space-y-2">
          {MODES.map((m) => {
            const active = keyMode === m;
            return (
              <button
                key={m}
                type="button"
                disabled={savingMode}
                onClick={() => saveMode(m)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  active ? "border-primary bg-accent/40" : "hover:bg-accent/30",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                  )}
                >
                  {active && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(`mode.${m}.label`)}</span>
                  <span className="block text-xs text-muted-foreground">{t(`mode.${m}.desc`)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <Separator />

      {/* Default spend limits (shared key only) */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t("limits.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("limits.desc")}</p>
        </div>

        {keyMode === "own_only" ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            {t("limits.ownOnlyNote")}
          </p>
        ) : (
          <>
            {/* Instance-wide monthly budget — the org's whole shared-key bill.
                Drives the analytics overrun trigger and "% of budget" line. */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("budget.label")}</label>
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
              <p className="text-xs text-muted-foreground">{t("budget.hint")}</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {([
                ["limit5h", limit5h, setLimit5h, t("limits.window.h5")],
                ["limitWeek", limitWeek, setLimitWeek, t("limits.window.d7")],
                ["limitMonth", limitMonth, setLimitMonth, t("limits.window.d30")],
              ] as const).map(([key, val, set, lbl]) => (
                <div key={key} className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">{lbl}</label>
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
            <p className="text-xs text-muted-foreground">{t("limits.hint")}</p>
            <Button size="sm" onClick={saveLimits} disabled={savingLimits}>
              {savingLimits && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tc("save")}
            </Button>
          </>
        )}
      </div>

      <Separator />

      {/* Per-user tiers — scaffolded for a later iteration. */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("tiers.title")}</h3>
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {t("tiers.soon")}
        </p>
      </div>
    </div>
  );
}
