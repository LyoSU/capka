"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelPicker } from "@/components/chat/model-picker";
import { ClawMark } from "@/components/brand/claw-mark";
import { iconForSlug } from "@/components/chat/provider-icons";
import { PROVIDER_OPTIONS, PROVIDER_META, type ProviderName } from "@/lib/providers/registry";
import { SETUP_STEPS, type SetupStep } from "@/lib/setup-steps";

const STEPS = SETUP_STEPS;

const INPUT_CLASS =
  "h-11 rounded-xl border-transparent bg-muted/60 px-3.5 text-[15px] focus-visible:border-ring focus-visible:bg-card";

/** Minimal 2-step progress: a pair of bars that fill as the admin advances. */
function StepBars({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {STEPS.map((label, i) => (
        <span
          key={label}
          className={`h-1 flex-1 rounded-full transition-colors duration-500 ${i <= current ? "bg-primary" : "bg-border"}`}
        />
      ))}
    </div>
  );
}

export function SetupWizard({
  initialStep,
  signedIn,
}: {
  initialStep: SetupStep;
  signedIn: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("setup");
  // The server resolves where to resume (see lib/setup). Once a session exists
  // the account is already created, so we never re-show — or let the user back
  // into — the account step; doing so would dead-end on a duplicate sign-up.
  const [step, setStep] = useState(() => Math.max(0, STEPS.indexOf(initialStep)));
  const [loading, setLoading] = useState(false);

  // Step 1 - Account
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Step 2 - Provider
  const [provider, setProvider] = useState<ProviderName>("litellm");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");

  const meta = PROVIDER_META[provider];

  function changeProvider(next: ProviderName) {
    setProvider(next);
    setApiKey("");
    setDefaultModel("");
    setBaseUrl(PROVIDER_META[next].defaultBaseUrl ?? "");
  }

  const [showApiKey, setShowApiKey] = useState(false);

  async function handleAccount() {
    if (!name || !email || !password) {
      toast.error(t("account.allFieldsRequired"));
      return;
    }
    if (password.length < 8) {
      toast.error(t("account.passwordTooShort"));
      return;
    }

    setLoading(true);
    try {
      const { error } = await authClient.signUp.email({
        name,
        email,
        password,
      });
      if (error) {
        toast.error(error.message || t("account.error"));
        return;
      }

      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "account" }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || t("account.error"));
        return;
      }

      setStep(1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("account.error"));
    } finally {
      setLoading(false);
    }
  }

  async function handleProvider() {
    if (!provider) {
      toast.error(t("provider.selectProvider"));
      return;
    }
    if (meta.requiresKey && !apiKey) {
      toast.error(t("provider.keyRequired"));
      return;
    }
    if (meta.requiresBaseUrl && !baseUrl) {
      toast.error(t("provider.baseUrlRequired"));
      return;
    }
    if (!defaultModel) {
      toast.error(t("provider.pickModelError"));
      return;
    }

    setLoading(true);
    try {
      // Test connection first
      const testRes = await fetch("/api/settings/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: meta.requiresKey ? apiKey : undefined,
          modelId: defaultModel,
          baseUrl: meta.requiresBaseUrl ? baseUrl : undefined,
        }),
      });
      const testData = await testRes.json();
      if (!testData.success) {
        toast.error(testData.error || t("provider.testError"));
        return;
      }

      // Save provider, then mark setup complete — the provider is the last
      // gate to getting started, so saving it finishes onboarding outright.
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: "provider",
          provider,
          apiKey: meta.requiresKey ? apiKey : undefined,
          baseUrl: meta.requiresBaseUrl ? baseUrl : undefined,
          defaultModel,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || t("provider.saveError"));
        return;
      }

      const done = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "complete" }),
      });
      if (!done.ok) {
        const data = await done.json();
        toast.error(data.error || t("provider.saveError"));
        return;
      }

      router.push("/chat");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("provider.verifyError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      {/* Calm claw monogram, far behind. Solid stroke + element-level opacity so the
          overlapping strokes flatten into one layer (no darker intersections), and the
          opaque card on top keeps it a clean backdrop that never tangles with content. */}
      <ClawMark className="pointer-events-none absolute left-1/2 top-1/2 h-[165vmin] w-[165vmin] -translate-x-1/2 -translate-y-1/2 text-foreground opacity-[0.03]" />

      <div className="relative flex min-h-screen items-center justify-center px-5 py-12">
        <div className="animate-card-morph w-full max-w-md rounded-[1.75rem] border border-border/60 bg-card p-7 shadow-[0_1px_2px_oklch(0_0_0/0.05),0_28px_60px_-32px_oklch(0.2_0.01_60/0.28)] sm:p-8">
          <div className="flex flex-col items-center gap-2.5 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <ClawMark className="h-[22px] w-[22px]" />
            </span>
            <span className="text-sm font-medium tracking-tight text-muted-foreground">{t("brand.wordmark")}</span>
          </div>

          <div className="mt-7">
            <StepBars current={step} />
          </div>

            <div key={step} className="animate-blur-rise mt-6 space-y-6">
              <div className="space-y-1.5">
                <h1 className="font-display text-[1.75rem] leading-tight tracking-tight text-balance">
                  {step === 0 ? t("account.title") : t("provider.title")}
                </h1>
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
                  {step === 0 ? t("account.subtitle") : t("provider.subtitle")}
                </p>
              </div>

              {step === 0 && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="name">{t("account.name")}</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("account.namePlaceholder")}
                      className={INPUT_CLASS}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="email">{t("account.email")}</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t("account.emailPlaceholder")}
                      className={INPUT_CLASS}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="password">{t("account.password")}</Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t("account.passwordPlaceholder")}
                      className={INPUT_CLASS}
                    />
                  </div>
                  <Button className="h-11 w-full rounded-xl text-[15px]" onClick={handleAccount} disabled={loading}>
                    {loading ? t("account.submitting") : t("account.submit")}
                  </Button>
                </div>
              )}

              {step === 1 && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label>{t("provider.field")}</Label>
                    <Select value={provider} onValueChange={(v) => changeProvider(v as ProviderName)}>
                      <SelectTrigger className="h-auto w-full rounded-xl border-transparent bg-muted/60 py-2.5">
                        <SelectValue />
                      </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((p) => {
                  const Icon = iconForSlug(p.iconSlug);
                  return (
                    <SelectItem key={p.value} value={p.value} className="py-2">
                      <span className="flex items-start gap-2.5 whitespace-normal">
                        <Icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-1.5 font-medium">
                            {p.label}
                            {p.recommended && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{t("provider.recommended")}</span>
                            )}
                          </span>
                          <span className="text-xs leading-snug text-muted-foreground">{p.blurb}</span>
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

                  {meta.requiresKey && (
                    <div className="space-y-1.5">
                      <Label htmlFor="apiKey">{t("provider.apiKey")}</Label>
                      <div className="relative">
                        <Input
                          id="apiKey"
                          type={showApiKey ? "text" : "password"}
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder="sk-..."
                          className={`${INPUT_CLASS} pr-10`}
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey((v) => !v)}
                          aria-label={showApiKey ? t("provider.hideKey") : t("provider.showKey")}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  )}

                  {meta.requiresBaseUrl && (
                    <div className="space-y-1.5">
                      <Label htmlFor="baseUrl">{t("provider.baseUrl")}</Label>
                      <Input
                        id="baseUrl"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={meta.baseUrlPlaceholder}
                        className={INPUT_CLASS}
                      />
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label>{t("provider.model")}</Label>
                    <ModelPicker
                      variant="field"
                      value={defaultModel}
                      onChange={setDefaultModel}
                      provider={provider}
                      apiKey={apiKey}
                      baseUrl={baseUrl}
                      disabled={(meta.requiresKey && !apiKey) || (meta.requiresBaseUrl && !baseUrl)}
                      placeholder={meta.requiresKey && !apiKey ? t("provider.enterKeyFirst") : t("provider.pickModel")}
                    />
                  </div>

                  <div className="flex gap-2">
                    {!signedIn && (
                      <Button variant="ghost" className="h-11 rounded-xl" onClick={() => setStep(0)} disabled={loading}>
                        {t("back")}
                      </Button>
                    )}
                    <Button className="h-11 flex-1 rounded-xl text-[15px]" onClick={handleProvider} disabled={loading}>
                      {loading ? t("provider.submitting") : t("provider.submit")}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <p className="mt-7 text-center text-xs text-muted-foreground">{t("brand.footnote")}</p>
          </div>
        </div>
      </div>
  );
}
