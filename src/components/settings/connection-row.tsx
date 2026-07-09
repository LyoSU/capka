"use client";

import type { HTMLAttributes } from "react";
import { useTranslations } from "next-intl";
import { GripVertical, Trash2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ModelPicker } from "@/components/chat/model-picker";
import { ProviderGlyph } from "@/components/chat/provider-icons";
import { IconPicker } from "@/components/settings/icon-picker";
import { PROVIDER_META, providerLabel, type ProviderName } from "@/lib/providers/registry";
import { prettyName } from "@/lib/models/normalize";

export interface ProviderConfig {
  id: string;
  provider: string;
  defaultModel: string | null;
  baseUrl: string | null;
  isActive: boolean | null;
  shared: boolean | null;
  label: string | null;
  iconSlug: string | null;
  apiStyle: string | null;
}

/** One connection as a compact, draggable row that expands to its full settings.
 *  All mutations are pre-bound to this config's id by the parent, so the row
 *  itself is a dumb renderer. */
export function ConnectionRow({
  config: c,
  isAdmin,
  isDefault,
  expanded,
  onExpandedChange,
  dragging,
  dragHandleProps,
  rowRef,
  onToggle,
  onDelete,
  onUpdateModel,
  onLabelChange,
  onLabelCommit,
  onIconChange,
  onToggleShared,
  onUpdateApiStyle,
}: {
  config: ProviderConfig;
  isAdmin: boolean;
  isDefault: boolean;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  dragging: boolean;
  dragHandleProps: HTMLAttributes<HTMLButtonElement>;
  rowRef: (el: HTMLElement | null) => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onUpdateModel: (model: string) => void;
  onLabelChange: (label: string) => void;
  onLabelCommit: () => void;
  onIconChange: (slug: string | null) => void;
  onToggleShared: (shared: boolean) => void;
  onUpdateApiStyle: (style: string | null) => void;
}) {
  const t = useTranslations("settings.connections");
  const tc = useTranslations("common");
  const meta = PROVIDER_META[c.provider as ProviderName];
  const name = c.label?.trim() || providerLabel(c.provider);

  return (
    <div
      ref={rowRef}
      data-dragging={dragging}
      className="rounded-lg border bg-background transition-shadow data-[dragging=true]:relative data-[dragging=true]:z-10 data-[dragging=true]:opacity-90 data-[dragging=true]:shadow-md data-[dragging=true]:ring-1 data-[dragging=true]:ring-border"
    >
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          <button
            type="button"
            {...dragHandleProps}
            aria-label={t("reorder")}
            className="flex h-7 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/50 outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </button>

          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&[data-state=open]_.chevron]:rotate-180">
            <ProviderGlyph slug={c.iconSlug || meta?.iconSlug} size={16} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{name}</span>
            {c.label?.trim() && (
              <span className="shrink-0 text-[10px] text-muted-foreground">{providerLabel(c.provider)}</span>
            )}
            {isDefault && (
              <Badge className="shrink-0 text-[10px]">{t("default")}</Badge>
            )}
            {isAdmin && c.shared && (
              <Badge variant="secondary" className="shrink-0 text-[10px]">{t("shared")}</Badge>
            )}
            {!c.isActive && (
              <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">{t("disabled")}</Badge>
            )}
            <span className="ml-auto hidden truncate text-xs text-muted-foreground sm:inline">
              {c.defaultModel ? prettyName(c.defaultModel) : t("noModel")}
            </span>
            <ChevronDown className="chevron h-4 w-4 shrink-0 text-muted-foreground transition-transform" />
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="space-y-3 px-3 pb-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t("defaultModel")}</label>
            <ModelPicker
              variant="field"
              configId={c.id}
              value={c.defaultModel || ""}
              onChange={onUpdateModel}
              placeholder={t("pickModel")}
            />
            {isDefault && <p className="text-xs text-muted-foreground">{t("defaultModelHint")}</p>}
          </div>

          {/* OpenAI transport — Responses API by default; flip to Chat
              Completions if a setup needs the classic endpoint. */}
          {c.provider === "openai" && (
            <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("chatCompletions")}</p>
                <p className="text-xs text-muted-foreground">{t("chatCompletionsHint")}</p>
              </div>
              <Switch
                checked={c.apiStyle === "chat"}
                onCheckedChange={(v) => onUpdateApiStyle(v ? "chat" : null)}
                aria-label={t("chatCompletions")}
              />
            </div>
          )}

          {/* Sharing is an admin-only property: whether this key backs other
              users on the shared pool, or stays private to the admin. */}
          {isAdmin && (
            <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("shareWithUsers")}</p>
                <p className="text-xs text-muted-foreground">{t("shareWithUsersHint")}</p>
              </div>
              <Switch
                checked={c.shared ?? true}
                onCheckedChange={onToggleShared}
                aria-label={t("shareWithUsers")}
              />
            </div>
          )}

          {/* Naming + glyph only for base-URL providers (LiteLLM/Ollama),
              where the connection's real identity isn't fixed by the choice. */}
          {meta?.requiresBaseUrl && (
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <label className="text-xs text-muted-foreground">{t("connectionName")}</label>
                <Input
                  value={c.label ?? ""}
                  onChange={(e) => onLabelChange(e.target.value)}
                  onBlur={onLabelCommit}
                  placeholder={providerLabel(c.provider)}
                />
              </div>
              <IconPicker
                value={c.iconSlug ?? null}
                fallback={meta.iconSlug}
                onChange={onIconChange}
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch
                checked={!!c.isActive}
                onCheckedChange={onToggle}
                aria-label={c.isActive ? t("disable") : t("enable")}
              />
              {t("enabled")}
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {tc("delete")}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
