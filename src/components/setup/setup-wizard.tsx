"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, Eye, EyeOff } from "lucide-react";
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
import { iconForSlug } from "@/components/chat/provider-icons";
import { PROVIDER_OPTIONS, PROVIDER_META, type ProviderName } from "@/lib/providers/registry";

const STEPS = ["account", "provider", "telegram"] as const;

function Stepper({ current }: { current: number }) {
  const t = useTranslations("setup.steps");
  return (
    <div className="flex items-center gap-2 mb-8">
      {STEPS.map((label, i) => (
        <div key={i} className="flex items-center gap-2 flex-1">
          <div
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors ${
              i <= current
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {i < current ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </div>
          <span
            className={`text-xs font-medium hidden sm:inline ${
              i === current ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {t(label)}
          </span>
          {i < STEPS.length - 1 && (
            <div
              className={`flex-1 h-px transition-colors ${
                i < current ? "bg-primary" : "bg-border"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function SetupWizard() {
  const router = useRouter();
  const t = useTranslations("setup");
  const [step, setStep] = useState(0);
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

  // Step 3 - Telegram
  const [botToken, setBotToken] = useState("");

  const [showApiKey, setShowApiKey] = useState(false);

  const [userId, setUserId] = useState<string | null>(null);

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

      // Get session to retrieve userId
      const session = await authClient.getSession();
      if (session.data?.user?.id) {
        setUserId(session.data.user.id);
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

      // Save provider
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          step: "provider",
          userId,
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

      setStep(2);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("provider.verifyError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleFinish(skip: boolean) {
    setLoading(true);
    try {
      // Save telegram token + register webhook
      if (!skip && botToken) {
        const res = await fetch("/api/settings/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botToken }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error || t("telegram.saveTokenError"));
          return;
        }
        if (data.warning) {
          toast.warning(data.warning);
        }
      }

      // Mark setup complete
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "complete" }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || t("telegram.completeError"));
        return;
      }

      router.push("/chat");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("telegram.finishError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <Stepper current={step} />

      <div className="text-center space-y-1">
        <h1 className="text-xl font-semibold">
          {step === 0 && t("account.title")}
          {step === 1 && t("provider.title")}
          {step === 2 && t("telegram.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {step === 0 && t("account.subtitle")}
          {step === 1 && t("provider.subtitle")}
          {step === 2 && t("telegram.subtitle")}
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
            />
          </div>
          <Button className="w-full" onClick={handleAccount} disabled={loading}>
            {loading ? t("account.submitting") : t("account.submit")}
          </Button>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("provider.field")}</Label>
            <Select value={provider} onValueChange={(v) => changeProvider(v as ProviderName)}>
              <SelectTrigger className="w-full h-auto py-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((p) => {
                  const Icon = iconForSlug(p.iconSlug);
                  return (
                    <SelectItem key={p.value} value={p.value}>
                      <span className="flex items-center gap-2.5">
                        <Icon size={16} className="shrink-0 text-muted-foreground" />
                        <span className="flex flex-col">
                          <span className="flex items-center gap-1.5 font-medium">
                            {p.label}
                            {p.recommended && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{t("provider.recommended")}</span>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">{p.blurb}</span>
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
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? t("provider.hideKey") : t("provider.showKey")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
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
            <Button
              variant="ghost"
              onClick={() => setStep(0)}
              disabled={loading}
            >
              {t("back")}
            </Button>
            <Button className="flex-1" onClick={handleProvider} disabled={loading}>
              {loading ? t("provider.submitting") : t("provider.submit")}
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="botToken">{t("telegram.botToken")}</Label>
            <Input
              id="botToken"
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:ABC-DEF..."
            />
            <p className="text-xs text-muted-foreground">
              {t("telegram.hint")}
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => setStep(1)}
              disabled={loading}
            >
              {t("back")}
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => handleFinish(true)}
              disabled={loading}
            >
              {t("telegram.skip")}
            </Button>
            <Button
              className="flex-1"
              onClick={() => handleFinish(false)}
              disabled={loading || !botToken}
            >
              {loading ? t("telegram.submitting") : t("telegram.submit")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
