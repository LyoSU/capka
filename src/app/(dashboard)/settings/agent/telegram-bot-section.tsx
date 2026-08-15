"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/**
 * The instance's Telegram bot token.
 *
 * Lived on its own Integrations page, which was one nav entry holding this one
 * section. It sits on Agent now, beside the rest of what the assistant is and
 * how people reach it. Personal account linking is elsewhere (Settings →
 * General) so every role can reach it without an admin page.
 */
export function TelegramBotSection() {
  const t = useTranslations("settings.integrations");
  const tc = useTranslations("common");
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    fetch("/api/settings?key=telegram_bot_token")
      .then((r) => r.json())
      .then((d) => {
        setHasToken(!!d.value);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    if (!botToken.trim()) {
      toast.error(t("enterToken"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t("botConnected", { username: data.botUsername }));
        // The API's own `warning`/`error` strings are hardcoded English operator
        // prose; only their presence is used here, never their text.
        if (data.warning) toast.warning(t("botStartWarning"));
        setHasToken(true);
        setBotToken("");
      } else {
        toast.error(t("saveTokenFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    // The id is the deep-link target settings search and the "configure the bot
    // first" hint both jump to, now that this has no page of its own.
    <div id="telegram-bot" className="scroll-mt-24">
    <SettingsSection
      title={t("telegram.title")}
      description={t("telegram.desc")}
      footnote={t("linkMovedHint")}
    >
      <div className="flex items-center gap-2">
        {!loaded ? (
          <Badge variant="secondary" className="text-xs text-muted-foreground">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            {t("checking")}
          </Badge>
        ) : hasToken ? (
          <Badge variant="outline" className="text-xs">{t("tokenConfigured")}</Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">{t("notConfigured")}</Badge>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          type="password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder={hasToken ? t("telegram.placeholderReplace") : "123456:ABC-DEF..."}
        />
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {tc("save")}
        </Button>
      </div>
    </SettingsSection>
    </div>
  );
}
