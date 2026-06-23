"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";

/** Admin control: may non-admin members install plugins (personally) from the
 *  connected marketplaces? Persists to the `members_can_install_plugins` setting. */
export default function MembersInstallToggle() {
  const t = useTranslations("settings.skills.installed");
  const [on, setOn] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/settings?key=members_can_install_plugins")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setOn(d?.value === "true"))
      .finally(() => setLoaded(true));
  }, []);

  const toggle = async (v: boolean) => {
    setOn(v);
    const r = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "members_can_install_plugins", value: v ? "true" : "false" }),
    });
    if (!r.ok) { setOn(!v); toast.error(t("actionFailed")); }
  };

  if (!loaded) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t("memberInstallTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("memberInstallHint")}</p>
      </div>
      <Switch checked={on} onCheckedChange={toggle} aria-label={t("memberInstallTitle")} />
    </div>
  );
}
