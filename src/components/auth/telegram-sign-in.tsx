"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { authErrorKey } from "@/lib/auth/client-error";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/** The Telegram glyph (paper-plane), brand-blue, so the button reads instantly
 *  as "Telegram" without pulling in an icon font. */
function TelegramGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M21.94 4.6 18.7 19.86c-.24 1.08-.88 1.35-1.78.84l-4.92-3.63-2.37 2.28c-.26.26-.48.48-.99.48l.35-5.01 9.12-8.24c.4-.35-.09-.55-.62-.2L4.92 13.6l-4.86-1.52c-1.06-.33-1.08-1.06.22-1.57l19-7.32c.88-.33 1.65.2 1.36 1.41Z" />
    </svg>
  );
}

/**
 * "Sign in with Telegram" — kicks off the better-auth genericOAuth redirect to
 * oauth.telegram.org. A plain redirect (not the iframe widget), so there are no
 * COOP/popup pitfalls. Renders nothing until we know it's enabled, so a
 * half-configured instance never shows a dead button.
 */
export function TelegramSignIn({ enabled, callbackURL = "/chat" }: { enabled: boolean | null; callbackURL?: string }) {
  const t = useTranslations("auth");
  const [loading, setLoading] = useState(false);

  if (!enabled) return null;

  const start = async () => {
    setLoading(true);
    const { error } = await authClient.signIn.oauth2({
      providerId: "telegram",
      callbackURL,
      errorCallbackURL: "/login?error=telegram",
    });
    // On success better-auth redirects away; reaching here means it failed.
    if (error) {
      const key = authErrorKey(error);
      toast.error(key ? t(`errors.${key}`) : t("telegram.failed"));
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      onClick={start}
      disabled={loading}
      className="h-11 w-full rounded-xl bg-[#229ED9] text-[15px] text-white hover:bg-[#1c8dc2]"
    >
      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TelegramGlyph className="mr-2 h-5 w-5" />}
      {t("telegram.signIn")}
    </Button>
  );
}

/** A subtle "or" divider between the Telegram button and the email form. */
export function AuthDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
