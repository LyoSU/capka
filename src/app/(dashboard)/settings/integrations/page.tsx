"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Link2, Copy, Check, Send } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export default function IntegrationsPage() {
  const t = useTranslations("settings.integrations");
  const tc = useTranslations("common");
  const [botToken, setBotToken] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  // Link state
  const [linked, setLinked] = useState(false);
  const [linkUsername, setLinkUsername] = useState<string | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [codeExpiry, setCodeExpiry] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkLoading, setLinkLoading] = useState(true);
  const [unlinking, setUnlinking] = useState(false);

  const fetchLinkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/telegram/link");
      if (res.ok) {
        const data = await res.json();
        setLinked(data.linked);
        setLinkUsername(data.username);
        setBotUsername(data.botUsername ?? null);
      }
    } finally {
      setLinkLoading(false);
    }
  }, []);

  useEffect(() => {
    // Check if bot token is configured
    fetch("/api/settings?key=telegram_bot_token")
      .then((r) => r.json())
      .then((d) => {
        setHasToken(!!d.value);
        setTokenLoaded(true);
      })
      .catch(() => setTokenLoaded(true));

    fetchLinkStatus();
  }, [fetchLinkStatus]);

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
        // Carry the freshly-validated username into the link section so its
        // deep link / QR work immediately, without a page reload.
        if (data.botUsername) setBotUsername(data.botUsername);
        setBotToken("");
      } else {
        toast.error(data.error || t("saveTokenFailed"));
      }
    } finally {
      setTokenSaving(false);
    }
  };

  const handleGenerateCode = async () => {
    setGeneratingCode(true);
    try {
      const res = await fetch("/api/settings/telegram/link", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setLinkCode(data.code);
        setCodeExpiry(data.expiresAt);
      } else {
        toast.error(t("generateFailed"));
      }
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      const res = await fetch("/api/settings/telegram/link", { method: "DELETE" });
      if (res.ok) {
        setLinked(false);
        setLinkUsername(null);
        setLinkCode(null);
        toast.success(t("link.unlinked"));
      } else {
        toast.error(t("link.unlinkFailed"));
      }
    } finally {
      setUnlinking(false);
    }
  };

  const handleCopyCode = () => {
    if (linkCode) {
      navigator.clipboard.writeText(`/link ${linkCode}`);
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>
      <Separator />

      {/* Telegram Bot Token */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">{t("telegram.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("telegram.desc")}
          </p>
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
      </div>

      <Separator />

      {/* Link Account */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">{t("link.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("link.desc")}
          </p>
        </div>

        {linkLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("link.checkingStatus")}
          </div>
        ) : linked ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md border p-3">
              <Link2 className="h-4 w-4 text-success" />
              <span className="text-sm">
                {linkUsername ? t("link.linkedAs", { username: linkUsername }) : t("link.linked")}
              </span>
              <Badge variant="outline" className="ml-auto text-xs">
                {t("link.connected")}
              </Badge>
            </div>
            <Button variant="ghost" size="sm" onClick={handleUnlink} disabled={unlinking}>
              {unlinking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("link.changeAccount")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {linkCode ? (
              <div className="space-y-3 rounded-md border p-4">
                {botUsername ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {t("link.openBotHint")}
                    </p>
                    <a
                      href={`https://t.me/${botUsername}?start=${linkCode}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(buttonVariants(), "w-full")}
                    >
                      <Send className="mr-2 h-4 w-4" />
                      {t("link.openBot", { username: botUsername })}
                    </a>
                    <div className="flex flex-col items-center gap-2 pt-1">
                      <div className="rounded-lg bg-white p-3">
                        <QRCodeSVG
                          value={`https://t.me/${botUsername}?start=${linkCode}`}
                          size={148}
                          marginSize={2}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t("link.scanQr")}
                      </p>
                    </div>
                    <Separator />
                    <p className="text-xs text-muted-foreground">
                      {t("link.orManually")}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("link.sendCommand")}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono">
                    /link {linkCode}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={handleCopyCode}
                  >
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {codeExpiry && (
                  <p className="text-xs text-muted-foreground">
                    {t("link.codeExpires")}
                  </p>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLinkCode(null);
                    fetchLinkStatus();
                  }}
                >
                  {t("link.doneRefresh")}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={handleGenerateCode}
                disabled={generatingCode || !botUsername}
              >
                {generatingCode && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                <Link2 className="mr-2 h-4 w-4" />
                {t("link.generateCode")}
              </Button>
            )}
            {!botUsername && (
              <p className="text-xs text-muted-foreground">
                {t("link.configureFirst")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
