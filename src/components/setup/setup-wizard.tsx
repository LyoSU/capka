"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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

const STEPS = ["Account", "Provider", "Telegram"] as const;
const PROVIDERS = ["openai", "anthropic", "openrouter", "ollama"] as const;
type Provider = (typeof PROVIDERS)[number];

function Stepper({ current }: { current: number }) {
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
            {label}
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
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // Step 1 - Account
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Step 2 - Provider
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/api");
  const [defaultModel, setDefaultModel] = useState("");

  // Step 3 - Telegram
  const [botToken, setBotToken] = useState("");

  const [showApiKey, setShowApiKey] = useState(false);

  const [userId, setUserId] = useState<string | null>(null);

  async function handleAccount() {
    if (!name || !email || !password) {
      const missing = [!name && "Name", !email && "Email", !password && "Password"].filter(Boolean).join(", ");
      toast.error(`${missing} ${missing.includes(",") ? "are" : "is"} required`);
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
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
        toast.error(error.message || "Could not create account. Please try again.");
        return;
      }

      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "account" }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Could not create account. Please try again.");
        return;
      }

      // Get session to retrieve userId
      const session = await authClient.getSession();
      if (session.data?.user?.id) {
        setUserId(session.data.user.id);
      }

      setStep(1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create account. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleProvider() {
    if (!provider) {
      toast.error("Select a provider");
      return;
    }
    if (provider !== "ollama" && !apiKey) {
      toast.error("API key is required");
      return;
    }
    if (!defaultModel) {
      toast.error("Default model is required");
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
          apiKey: provider !== "ollama" ? apiKey : undefined,
          modelId: defaultModel,
          baseUrl: provider === "ollama" ? baseUrl : undefined,
        }),
      });
      const testData = await testRes.json();
      if (!testData.success) {
        toast.error(testData.error || "Could not verify API key. Please check the key and try again.");
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
          apiKey: provider !== "ollama" ? apiKey : undefined,
          baseUrl: provider === "ollama" ? baseUrl : undefined,
          defaultModel,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Could not save provider settings. Please try again.");
        return;
      }

      setStep(2);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not verify API key. Please check the key and try again.");
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
          toast.error(data.error || "Failed to save Telegram token");
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
        toast.error(data.error || "Failed to complete setup");
        return;
      }

      router.push("/chat");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not complete setup. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <Stepper current={step} />

      <div className="text-center space-y-1">
        <h1 className="text-xl font-semibold">
          {step === 0 && "Create your account"}
          {step === 1 && "Configure AI provider"}
          {step === 2 && "Telegram integration"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {step === 0 && "Set up your admin account to get started"}
          {step === 1 && "Connect an AI provider to power your assistant"}
          {step === 2 && "Optionally connect a Telegram bot"}
        </p>
      </div>

      {step === 0 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
            />
          </div>
          <Button className="w-full" onClick={handleAccount} disabled={loading}>
            {loading ? "Creating..." : "Create Account"}
          </Button>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {provider !== "ollama" && (
            <div className="space-y-1.5">
              <Label htmlFor="apiKey">API Key</Label>
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
                  aria-label={showApiKey ? "Hide API key" : "Show API key"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          {provider === "ollama" && (
            <div className="space-y-1.5">
              <Label htmlFor="baseUrl">Base URL</Label>
              <Input
                id="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/api"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Default Model</Label>
            <Input
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder={
                provider === "openrouter" ? "openai/gpt-5.2"
                  : provider === "openai" ? "gpt-5.2"
                  : provider === "anthropic" ? "claude-sonnet-4-20250514"
                  : "llama3.3"
              }
            />
            <p className="text-xs text-muted-foreground">
              {provider === "openrouter"
                ? "Format: provider/model (e.g. openai/gpt-5.2, anthropic/claude-sonnet-4)"
                : "Enter the model ID from your provider"}
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => setStep(0)}
              disabled={loading}
            >
              Back
            </Button>
            <Button className="flex-1" onClick={handleProvider} disabled={loading}>
              {loading ? "Testing..." : "Test & Save"}
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="botToken">Bot Token</Label>
            <Input
              id="botToken"
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:ABC-DEF..."
            />
            <p className="text-xs text-muted-foreground">
              Get a token from @BotFather on Telegram. You can skip this and set it up later.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => setStep(1)}
              disabled={loading}
            >
              Back
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => handleFinish(true)}
              disabled={loading}
            >
              Skip
            </Button>
            <Button
              className="flex-1"
              onClick={() => handleFinish(false)}
              disabled={loading || !botToken}
            >
              {loading ? "Saving..." : "Save & Finish"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
