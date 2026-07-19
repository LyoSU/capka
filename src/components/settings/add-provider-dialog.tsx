"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Loader2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { ModelPicker } from "@/components/chat/model-picker";
import { ProviderGlyph } from "@/components/chat/provider-icons";
import { IconPicker } from "@/components/settings/icon-picker";
import { PROVIDER_OPTIONS, PROVIDER_META, type ProviderName } from "@/lib/providers/registry";

/** The "add a connection" flow, in a modal so it never lengthens the list. Tests
 *  the connection before saving; on success calls onAdded so the list refetches. */
export function AddProviderDialog({ isAdmin, onAdded }: { isAdmin: boolean; onAdded: () => void }) {
  const t = useTranslations("settings.connections");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [provider, setProvider] = useState<ProviderName>("litellm");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [label, setLabel] = useState("");
  const [iconSlug, setIconSlug] = useState<string | null>(null);
  const [formShared, setFormShared] = useState(true);
  const [showKey, setShowKey] = useState(false);
  // OpenAI/Azure only: drive the model over Chat Completions instead of the
  // default Responses API. Off persists as null (auto = Responses); on
  // persists "chat".
  const [useChatApi, setUseChatApi] = useState(false);

  const meta = PROVIDER_META[provider];

  function changeProvider(next: ProviderName) {
    setProvider(next);
    setApiKey("");
    setDefaultModel("");
    setLabel("");
    setIconSlug(null);
    setUseChatApi(false);
    setBaseUrl(PROVIDER_META[next].defaultBaseUrl ?? "");
  }

  function reset() {
    setProvider("litellm");
    setApiKey("");
    setBaseUrl("");
    setDefaultModel("");
    setLabel("");
    setIconSlug(null);
    setUseChatApi(false);
    setFormShared(true);
    setShowKey(false);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  async function handleTestAndSave() {
    setSaving(true);
    try {
      const modelId = defaultModel || undefined;
      if (meta.requiresKey && !apiKey) {
        toast.error(t("keyRequired"));
        return;
      }
      if (meta.requiresBaseUrl && !baseUrl) {
        toast.error(t("baseUrlRequired"));
        return;
      }
      if (!modelId) {
        toast.error(t("pickModelError"));
        return;
      }

      // Required base URL falls back to the provider default; an OPTIONAL one
      // (Anthropic → compatible gateway) is sent only when the user typed
      // something, otherwise the SDK's own default endpoint is used.
      const effectiveBaseUrl = meta.requiresBaseUrl
        ? baseUrl || meta.defaultBaseUrl
        : meta.optionalBaseUrl
          ? baseUrl.trim() || undefined
          : undefined;
      // The wire transport only applies to OpenAI and Azure; default
      // (Responses) stays unset.
      const effectiveApiStyle = (provider === "openai" || provider === "azure") && useChatApi ? "chat" : undefined;

      const testRes = await fetch("/api/settings/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: meta.requiresKey ? apiKey : undefined,
          modelId,
          baseUrl: effectiveBaseUrl,
          apiStyle: effectiveApiStyle,
        }),
      });

      const testData = await testRes.json();
      if (!testData.success) {
        toast.error(t("connectionFailed", { error: testData.error }));
        return;
      }

      const saveRes = await fetch("/api/settings/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: meta.requiresKey ? apiKey : undefined,
          baseUrl: effectiveBaseUrl,
          defaultModel: modelId,
          label: meta.requiresBaseUrl ? label : undefined,
          iconSlug: meta.requiresBaseUrl ? iconSlug : undefined,
          shared: isAdmin ? formShared : undefined,
          apiStyle: effectiveApiStyle,
        }),
      });

      if (saveRes.ok) {
        toast.success(t("saved"));
        onOpenChange(false);
        onAdded();
      } else {
        toast.error(t("saveError"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        {t("addProvider")}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("addProvider")}</DialogTitle>
            <DialogDescription>{t("subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm">{t("providerField")}</label>
              <Select
                value={provider}
                onValueChange={(v) => changeProvider(v as ProviderName)}
                items={Object.fromEntries(
                  PROVIDER_OPTIONS.map((p) => [
                    p.value,
                    <>
                      <ProviderGlyph slug={p.iconSlug} size={16} className="shrink-0 text-muted-foreground" />
                      {p.label}
                    </>,
                  ])
                )}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">
                  {PROVIDER_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value} className="py-1.5">
                      <ProviderGlyph slug={p.iconSlug} size={16} className="shrink-0 text-muted-foreground" />
                      <span className="font-medium">{p.label}</span>
                      {p.recommended && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {t("recommended")}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-snug text-muted-foreground">
                {PROVIDER_OPTIONS.find((p) => p.value === provider)?.blurb}
              </p>
            </div>

            {meta.requiresKey && (
              <div className="space-y-1.5">
                <label className="text-sm">{t("apiKey")}</label>
                <div className="relative">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? t("hideKey") : t("showKey")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}

            {(meta.requiresBaseUrl || meta.optionalBaseUrl) && (
              <div className="space-y-1.5">
                <label className="text-sm">{t("baseUrl")}</label>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={meta.baseUrlPlaceholder} />
              </div>
            )}

            {(provider === "openai" || provider === "azure") && (
              <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("chatCompletions")}</p>
                  <p className="text-xs text-muted-foreground">{t("chatCompletionsHint")}</p>
                </div>
                <Switch checked={useChatApi} onCheckedChange={setUseChatApi} aria-label={t("chatCompletions")} />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-sm">{t("model")}</label>
              <ModelPicker
                variant="field"
                value={defaultModel}
                onChange={setDefaultModel}
                provider={provider}
                apiKey={apiKey}
                baseUrl={baseUrl}
                disabled={(meta.requiresKey && !apiKey) || (meta.requiresBaseUrl && !baseUrl)}
                placeholder={meta.requiresKey && !apiKey ? t("enterKeyFirst") : t("pickModel")}
              />
            </div>

            {meta.requiresBaseUrl && (
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <label className="text-sm">{t("connectionName")}</label>
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("connectionNamePlaceholder")} />
                </div>
                <IconPicker value={iconSlug} fallback={meta.iconSlug} onChange={setIconSlug} />
              </div>
            )}

            {isAdmin && (
              <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("shareWithUsers")}</p>
                  <p className="text-xs text-muted-foreground">{t("shareWithUsersHint")}</p>
                </div>
                <Switch checked={formShared} onCheckedChange={setFormShared} aria-label={t("shareWithUsers")} />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              {tc("cancel")}
            </Button>
            <Button onClick={handleTestAndSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("testSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
