"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, Link2, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export default function IntegrationsPage() {
  const [botToken, setBotToken] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  // Link state
  const [linked, setLinked] = useState(false);
  const [linkUsername, setLinkUsername] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [codeExpiry, setCodeExpiry] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkLoading, setLinkLoading] = useState(true);

  const fetchLinkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/telegram/link");
      if (res.ok) {
        const data = await res.json();
        setLinked(data.linked);
        setLinkUsername(data.username);
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
      toast.error("Enter a bot token");
      return;
    }
    setTokenSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "telegram_bot_token",
          value: botToken.trim(),
          encrypted: true,
        }),
      });
      if (res.ok) {
        toast.success("Bot token saved");
        setHasToken(true);
        setBotToken("");
      } else {
        toast.error("Failed to save token");
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
        toast.error("Failed to generate link code");
      }
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleCopyCode = () => {
    if (linkCode) {
      navigator.clipboard.writeText(`/link ${linkCode}`);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h2 className="text-base font-medium">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect external services to AntiClaw.
        </p>
      </div>
      <Separator />

      {/* Telegram Bot Token */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Telegram Bot</h3>
          <p className="text-sm text-muted-foreground">
            Enter your Telegram bot token from @BotFather to enable Telegram
            integration.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {hasToken && tokenLoaded ? (
            <Badge variant="outline" className="text-xs">
              Token configured
            </Badge>
          ) : tokenLoaded ? (
            <Badge variant="secondary" className="text-xs">
              Not configured
            </Badge>
          ) : null}
        </div>

        <div className="flex gap-2">
          <Input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={hasToken ? "Enter new token to replace" : "123456:ABC-DEF..."}
          />
          <Button onClick={handleSaveToken} disabled={tokenSaving}>
            {tokenSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </div>

      <Separator />

      {/* Link Account */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Link Telegram Account</h3>
          <p className="text-sm text-muted-foreground">
            Connect your Telegram account to chat with AntiClaw from Telegram.
          </p>
        </div>

        {linkLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking status...
          </div>
        ) : linked ? (
          <div className="flex items-center gap-2 rounded-md border p-3">
            <Link2 className="h-4 w-4 text-green-500" />
            <span className="text-sm">
              Linked{linkUsername ? ` as @${linkUsername}` : ""}
            </span>
            <Badge variant="outline" className="ml-auto text-xs">
              Connected
            </Badge>
          </div>
        ) : (
          <div className="space-y-3">
            {linkCode ? (
              <div className="space-y-2 rounded-md border p-4">
                <p className="text-sm text-muted-foreground">
                  Send this command to the bot in Telegram:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-3 py-2 text-sm font-mono">
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
                    Code expires in 5 minutes
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
                  Done / Refresh status
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                onClick={handleGenerateCode}
                disabled={generatingCode || !hasToken}
              >
                {generatingCode && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                <Link2 className="mr-2 h-4 w-4" />
                Generate Link Code
              </Button>
            )}
            {!hasToken && (
              <p className="text-xs text-muted-foreground">
                Configure the bot token above before linking your account.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
