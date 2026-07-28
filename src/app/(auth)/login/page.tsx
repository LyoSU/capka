"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const [telegramEnabled, setTelegramEnabled] = useState<boolean | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);

  useEffect(() => {
    fetch("/api/auth/registration-status")
      .then((r) => r.json())
      .then((d) => {
        setTelegramEnabled(!!d.telegram?.enabled);
        setRegistrationEnabled(d.enabled !== false);
      })
      // Fail open, like the register page does: a dropped status call used to
      // leave `registrationEnabled` false forever, so a first-time user on a
      // flaky network got a sign-in card with no way to create an account.
      // Offering a link that may 404 beats hiding the only way in.
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
    setError(null);

    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });

    if (signInError) {
      const key = authErrorKey(signInError);
      // Inline, not a toast: a wrong password is a property of the form, and a
      // sonner that has already faded leaves the fields re-enabled with no
      // explanation of why nothing happened.
      setError(key ? t(`errors.${key}`) : t("login.invalidCredentials"));
      setLoading(false);
      return;
    }

    router.push("/chat");
  }

  // Held until the status call settles. Rendering early meant the Telegram
  // button appeared ABOVE the email field a moment later and pushed it down —
  // under the cursor of anyone who had already started typing.
  if (telegramEnabled === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
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
            placeholder={t("emailPlaceholder")}
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
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
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signin-error" : undefined}
            className={AUTH_FIELD}
          />
        </div>
        {error && (
          <p id="signin-error" role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}
        <Button type="submit" disabled={loading} className="h-11 w-full rounded-xl text-[15px]">
          {loading ? t("login.submitting") : t("login.submit")}
        </Button>
      </form>
    </AuthShell>
  );
}
