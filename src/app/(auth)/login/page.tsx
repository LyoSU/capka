"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell, AUTH_FIELD } from "@/components/auth/auth-shell";
import { TelegramSignIn, AuthDivider } from "@/components/auth/telegram-sign-in";
import { authErrorKey } from "@/lib/auth/client-error";
import { toast } from "sonner";

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [telegramEnabled, setTelegramEnabled] = useState<boolean | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

  useEffect(() => {
    fetch("/api/auth/registration-status")
      .then((r) => r.json())
      .then((d) => {
        setTelegramEnabled(!!d.telegram?.enabled);
        setRegistrationEnabled(d.enabled !== false);
      })
      .catch(() => setTelegramEnabled(false));
    // Surface a failed Telegram round-trip (the error callback redirects here).
    const p = new URLSearchParams(window.location.search);
    if (p.get("error") === "telegram") {
      toast.error(t("telegram.failed"));
      window.history.replaceState({}, "", "/login");
    }
  }, [t]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const { error } = await authClient.signIn.email({
      email,
      password,
    });

    if (error) {
      const key = authErrorKey(error);
      toast.error(key ? t(`errors.${key}`) : t("login.invalidCredentials"));
      setLoading(false);
      return;
    }

    router.push("/chat");
  }

  return (
    <AuthShell
      title={t("login.title")}
      description={t("login.description")}
      footer={
        registrationEnabled ? (
          <>
            {t("login.noAccount")}{" "}
            <Link href="/register" className="font-medium text-foreground hover:underline">
              {t("login.createOne")}
            </Link>
          </>
        ) : undefined
      }
    >
      {telegramEnabled && (
        <div className="mb-4 space-y-4">
          <TelegramSignIn enabled={telegramEnabled} />
          <AuthDivider label={t("orContinueWithEmail")} />
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("emailLabel")}</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
            autoFocus
            className={AUTH_FIELD}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">{t("passwordLabel")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
            className={AUTH_FIELD}
          />
        </div>
        <Button type="submit" disabled={loading} className="h-11 w-full rounded-xl text-[15px]">
          {loading ? t("login.submitting") : t("login.submit")}
        </Button>
      </form>
    </AuthShell>
  );
}
