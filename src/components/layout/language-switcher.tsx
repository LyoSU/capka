"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { locales, localeNames, type Locale } from "@/i18n/config";

/**
 * Switches the interface language for the signed-in user.
 *
 * The preference lives in the DB (`user.locale`) and is read per-request by
 * `resolveLocale`, so after saving we `router.refresh()` to re-render the tree
 * with the new locale's messages. Optimistic so the toggle reacts instantly.
 */
export function LanguageSwitcher() {
  const current = useLocale();
  const t = useTranslations("language");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string>(current);

  const change = async (next: Locale) => {
    if (next === selected || pending) return;
    const previous = selected;
    setSelected(next);
    const res = await fetch("/api/settings/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
    if (!res.ok) {
      setSelected(previous);
      toast.error(t("updateFailed"));
      return;
    }
    toast.success(t("updated"));
    startTransition(() => router.refresh());
  };

  return (
    <ToggleGroup
      value={[selected]}
      onValueChange={(values) => {
        if (values.length > 0) change(values[0] as Locale);
      }}
      variant="outline"
      size="sm"
    >
      {locales.map((loc) => (
        <ToggleGroupItem
          key={loc}
          value={loc}
          aria-label={localeNames[loc]}
          className="h-7 px-3 text-xs"
        >
          {localeNames[loc]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
