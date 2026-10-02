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
import { Hint } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { ModelPicker, clearClientModelsCache } from "@/components/chat/model-picker";
import { ProviderGlyph } from "@/components/chat/provider-icons";
import { IconPicker } from "@/components/settings/icon-picker";
import type { ProviderConfig } from "@/components/settings/connection-row";
import { PROVIDER_OPTIONS, PROVIDER_META, type ProviderName } from "@/lib/providers/registry";

/** The "add a connection" flow, in a modal so it never lengthens the list. Tests
 *  the connection before saving; on success calls onAdded so the list refetches.
 *  With `editing` it is the same form for an existing connection: provider is
 *  fixed, the key field is blank (blank = keep the stored key), and saving PUTs
 *  to the same id so models and chats that reference it keep working. */
export function AddProviderDialog({
  isAdmin,
  onAdded,
  editing,
  onEditClose,
}: {
  isAdmin: boolean;
  onAdded: () => void;
  editing?: ProviderConfig | null;
  onEditClose?: () => void;
}) {
  const t = useTranslations("settings.connections");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(!!editing);
  const [saving, setSaving] = useState(false);

  const [provider, setProvider] = useState<ProviderName>((editing?.provider as ProviderName) ?? "litellm");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [defaultModel, setDefaultModel] = useState(editing?.defaultModel ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [iconSlug, setIconSlug] = useState<string | null>(editing?.iconSlug ?? null);
  const [formShared, setFormShared] = useState(editing?.shared ?? true);
  const [showKey, setShowKey] = useState(false);
  // OpenAI/Azure only: drive the model over Chat Completions instead of the
  // default Responses API. Off persists as null (auto = Responses); on
  // persists "chat".
  const [useChatApi, setUseChatApi] = useState(editing?.apiStyle === "chat");

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
    if (!next) {
      reset();
      onEditClose?.();
    }
  }

  async function handleTestAndSave() {
    setSaving(true);
    try {
      const modelId = defaultModel || undefined;
      // Editing: a blank key keeps the stored one.
      const keepKey = !!editing && !apiKey;
      if (meta.requiresKey && !apiKey && !(keepKey && editing?.hasKey)) {
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
          apiKey: meta.requiresKey ? apiKey || undefined : undefined,
          configId: keepKey ? editing?.id : undefined,
          modelId,
          baseUrl: effectiveBaseUrl,
          apiStyle: effectiveApiStyle,
        }),
      });

      const testData = await testRes.json();
      if (!testData.success) {
        toast.error(editing ? t("editConnectionFailed", { error: testData.error }) : t("connectionFailed", { error: testData.error }));
        return;
      }

      if (editing) {
        const putRes = await fetch("/api/settings/providers", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: editing.id,
            apiKey: apiKey || undefined,
            baseUrl: effectiveBaseUrl ?? "",
            defaultModel: modelId,
            label,
            iconSlug,
            shared: isAdmin ? formShared : undefined,
            apiStyle: provider === "openai" || provider === "azure" ? effectiveApiStyle ?? null : undefined,
          }),
        });
        if (putRes.ok) {
          clearClientModelsCache();
          toast.success(t("editSaved"));
          onOpenChange(false);
          onAdded();
        } else {
          toast.error(t("saveError"));
        }
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
        clearClientModelsCache();
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
      {!editing && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus />
          {t("addProvider")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? t("editProvider") : t("addProvider")}</DialogTitle>
            <DialogDescription>{t("subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm">{t("providerField")}</label>
              <Select
                value={provider}
                onValueChange={(v) => changeProvider(v as ProviderName)}
                disabled={!!editing}
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
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">
                  {PROVIDER_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value} className="py-1.5">
                      <ProviderGlyph slug={p.iconSlug} size={16} className="shrink-0 text-muted-foreground" />
                      <span className="font-medium">{p.label}</span>
                      {p.recommended && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
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
                    placeholder={editing?.hasKey ? `•••• ${editing.keyHint ?? ""}`.trim() : "sk-..."}
                    className="pr-9"
                  />
                  <Hint label={showKey ? t("hideKey") : t("showKey")} side="left">
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </Hint>
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
                {...(editing && !apiKey && baseUrl === (editing.baseUrl ?? "")
                  ? { configId: editing.id }
                  : { provider, apiKey, baseUrl })}
                disabled={!editing && ((meta.requiresKey && !apiKey) || (meta.requiresBaseUrl && !baseUrl))}
                placeholder={!editing && meta.requiresKey && !apiKey ? t("enterKeyFirst") : t("pickModel")}
              />
            </div>

            {(meta.requiresBaseUrl || editing) && (
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
              {saving && <Loader2 className="animate-spin" />}
              {editing ? t("editSave") : t("testSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
