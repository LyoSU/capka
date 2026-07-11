"use client";

import { useTranslations } from "next-intl";
import { AlertCircle, ArrowRight, Download, Loader2 } from "lucide-react";
import Claude from "@lobehub/icons/es/Claude";
import OpenAI from "@lobehub/icons/es/OpenAI";
import { Button } from "@/components/ui/button";
import { sourceLabel } from "@/lib/import/detect";
import type { DetectedShareLink, ImportSource } from "@/lib/import/types";
import type { ImportPhase } from "./use-share-import";

/** The source's monochrome brand mark (Claude's, or the OpenAI/ChatGPT blossom —
 *  they share one glyph), tinted to the surrounding text color with no badge/
 *  background. Static component refs, so no "component created during render"
 *  lint. */
export function SourceGlyph({ source, size = 18, className }: { source: ImportSource; size?: number; className?: string }) {
  const cls = `text-muted-foreground ${className ?? ""}`;
  return source === "claude" ? <Claude size={size} className={cls} /> : <OpenAI size={size} className={cls} />;
}

/**
 * The calm offer that appears above the composer when a share link is pasted. It
 * walks the user through offer → (rendering) → preview → (creating), or shows a
 * plain-language error. Deliberately understated — one line of context, two
 * actions — so it reads as a helpful suggestion, not an interruption.
 */
export function ImportCard({
  detected,
  state,
  onImport,
  onConfirm,
  onDismiss,
  onRetry,
}: {
  detected: DetectedShareLink;
  state: ImportPhase;
  onImport: () => void;
  onConfirm: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations("chat.import");
  const service = sourceLabel(detected.source);

  return (
    <div className="mx-auto mb-2 max-w-3xl px-4 md:px-6 lg:max-w-4xl">
      <div className="rounded-2xl border bg-card/70 px-4 py-3 shadow-sm">
        {state.phase === "idle" && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-start gap-3">
              <SourceGlyph source={detected.source} size={18} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 text-sm text-foreground/90">{t("offer", { service })}</span>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                {t("dismiss")}
              </Button>
              <Button size="sm" onClick={onImport}>
                <Download className="h-3.5 w-3.5" />
                {t("import")}
              </Button>
            </div>
          </div>
        )}

        {(state.phase === "previewing" || state.phase === "committing") && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>{state.phase === "previewing" ? t("reading", { service }) : t("creating")}</span>
          </div>
        )}

        {state.phase === "preview" && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-start gap-3">
              <SourceGlyph source={detected.source} size={18} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium text-foreground">{state.data.title || t("untitled", { service })}</p>
                <p className="text-muted-foreground">
                  {t("summary", { service, count: state.data.messages.length })}
                </p>
                {(state.data.droppedRichContent || state.data.truncated) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {state.data.droppedRichContent && t("droppedNote")}
                    {state.data.droppedRichContent && state.data.truncated && " "}
                    {state.data.truncated && t("truncatedNote")}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                {t("cancel")}
              </Button>
              <Button size="sm" onClick={onConfirm}>
                {t("confirm")}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {state.phase === "error" && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-sm text-foreground/90">{errorText(t, state.code, service)}</span>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                {t("cancel")}
              </Button>
              {retryable(state.code) && (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {t("retry")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** NETWORK_DISABLED and PLAYWRIGHT_MISSING are deployment conditions retrying
 *  won't fix; everything else is worth another attempt. */
function retryable(code: string): boolean {
  return code !== "NETWORK_DISABLED" && code !== "PLAYWRIGHT_MISSING";
}

function errorText(t: ReturnType<typeof useTranslations>, code: string, service: string): string {
  const known = ["NETWORK_DISABLED", "PLAYWRIGHT_MISSING", "BLOCKED", "NOT_FOUND", "FORMAT_CHANGED", "EMPTY"];
  return t(`error.${known.includes(code) ? code : "RENDER_FAILED"}`, { service });
}
