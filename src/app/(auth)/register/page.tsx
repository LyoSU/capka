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
import { Loader2 } from "lucide-react";

export default function RegisterPage() {
  const router = useRouter();
  const t = useTranslations("auth");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean | null>(null);
  const [telegramEnabled, setTelegramEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    // Check if registration is enabled (public — no auth needed)
    fetch("/api/auth/registration-status")
      .then((r) => r.json())
      .then((data) => {
        setRegistrationEnabled(data.enabled !== false);
        setTelegramEnabled(!!data.telegram?.enabled);
      })
      .catch(() => { setRegistrationEnabled(true); setTelegramEnabled(false); });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError(t("register.nameRequired")); return; }
    setLoading(true);
    setError(null);

    const { error: signUpError } = await authClient.signUp.email({
      name,
      email,
      password,
    });

    if (signUpError) {
      const key = authErrorKey(signUpError);
      // Inline rather than a toast, for the same reason as sign-in: "this email
      // is already taken" has to still be on screen when the user looks back at
      // the field it is about.
      setError(key ? t(`errors.${key}`) : t("register.failed"));
      setLoading(false);
      return;
    }

    router.push("/chat");
  }

  if (registrationEnabled === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Email sign-up is closed — but Telegram may still be the open path in. Offer
  // it rather than dead-ending; fall back to the plain disabled notice otherwise.
  if (registrationEnabled === false) {
    return (
      <AuthShell
        title={telegramEnabled ? t("register.title") : t("register.disabledTitle")}
        description={telegramEnabled ? t("telegram.registerHint") : t("register.disabledDescription")}
        footer={
          <Link href="/login" className="font-medium text-foreground hover:underline">
            {t("register.backToSignIn")}
          </Link>
        }
      >
        {/* No Telegram either: the card would otherwise be a title, a sentence and
            a dangling gap. Say who can let them in instead of dead-ending. */}
        {telegramEnabled ? (
          <TelegramSignIn enabled={telegramEnabled} />
        ) : (
          <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
            {t("register.disabledAskAdmin")}
          </p>
        )}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t("register.title")}
      description={t("register.description")}
      footer={
        <>
          {t("register.haveAccount")}{" "}
          <Link href="/login" className="font-medium text-foreground hover:underline">
            {t("register.signIn")}
          </Link>
        </>
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
          <Label htmlFor="name">{t("register.nameLabel")}</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("register.namePlaceholder")}
            autoComplete="name"
            required
            disabled={loading}
            autoFocus
            className={AUTH_FIELD}
          />
        </div>
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
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signup-error" : undefined}
            className={AUTH_FIELD}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">{t("passwordLabel")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={loading}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "signup-error" : undefined}
            className={AUTH_FIELD}
          />
        </div>
        {error && (
          <p id="signup-error" role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}
        <Button type="submit" disabled={loading} className="h-11 w-full rounded-xl text-[15px]">
          {loading ? t("register.submitting") : t("register.submit")}
        </Button>
      </form>
    </AuthShell>
  );
}
