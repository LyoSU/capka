"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

/**
 * Admin-only org integration config. The bot *token* (one per instance) lives
 * here; personal account linking moved to Settings → General so every role can
 * reach it without seeing this admin page.
 */
export default function IntegrationsPage() {
  const t = useTranslations("settings.integrations");
  const tc = useTranslations("common");
  const [botToken, setBotToken] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    fetch("/api/settings?key=telegram_bot_token")
      .then((r) => r.json())
      .then((d) => {
        setHasToken(!!d.value);
        setTokenLoaded(true);
      })
      .catch(() => setTokenLoaded(true));
  }, []);

  const handleSaveToken = async () => {
    if (!botToken.trim()) {
      toast.error(t("enterToken"));
      return;
    }
    setTokenSaving(true);
    try {
      const res = await fetch("/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t("botConnected", { username: data.botUsername }));
        if (data.warning) toast.warning(data.warning);
        setHasToken(true);
        setBotToken("");
      } else {
        toast.error(data.error || t("saveTokenFailed"));
      }
    } finally {
      setTokenSaving(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <Separator />

      {/* Telegram Bot Token */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">{t("telegram.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("telegram.desc")}</p>
        </div>

        <div className="flex items-center gap-2">
          {!tokenLoaded ? (
            <Badge variant="secondary" className="text-xs text-muted-foreground">
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              {t("checking")}
            </Badge>
          ) : hasToken ? (
            <Badge variant="outline" className="text-xs">
              {t("tokenConfigured")}
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs">
              {t("notConfigured")}
            </Badge>
          )}
        </div>

        <div className="flex gap-2">
          <Input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={hasToken ? t("telegram.placeholderReplace") : "123456:ABC-DEF..."}
          />
          <Button onClick={handleSaveToken} disabled={tokenSaving}>
            {tokenSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {tc("save")}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">{t("linkMovedHint")}</p>
      </div>
    </div>
  );
}
