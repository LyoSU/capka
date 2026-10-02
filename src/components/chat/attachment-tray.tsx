"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { X, RotateCw, Loader2 } from "lucide-react";
import { BinaryFileThumb, FileThumb, usePreview, type PreviewFile } from "./file-preview";
import { isPastedText, type AttachedFile } from "./chat-input";
import { Hint } from "@/components/ui/tooltip";
import { fileKind, previewKind, splitFileName, thumbnailable } from "@/lib/file-kinds";
import { formatSize } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * The files staged for one message, as one row of compact chips: a small picture
 * (the first page or the photo when there is one, else the typed sheet) and the
 * name with its kind. The big landscape tile stays for files in the transcript;
 * here it stacked two-high on a phone and made the composer scroll inside itself.
 *
 * Shared by the composer and by both message editors — the chip, the ×, the
 * upload progress and the retry-on-failure are one implementation, because three
 * copies of "what a half-uploaded file looks like" is three chances to disagree.
 */
export function AttachmentTray({
  files, chatId, onRemove, onRetry, onInsertText, className,
}: {
  files: AttachedFile[];
  chatId: string;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  /** Puts a pasted-text chip's content back into the text box as editable text. */
  onInsertText?: (af: AttachedFile) => void;
  className?: string;
}) {
  const t = useTranslations("chat.input");
  const tp = useTranslations("chat.preview");
  const { open } = usePreview();

  // Thumbnails for locally-staged images (uploading / error), so a photo is
  // obviously a photo before it lands in the sandbox. Ready chips draw from the
  // sandbox instead, so they need no object-URL.
  const previews = useMemo(() => {
    const m = new Map<string, string>();
    for (const af of files) {
      if (af.file && af.file.type.startsWith("image/")) m.set(af.id, URL.createObjectURL(af.file));
    }
    return m;
  }, [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  // Ready files open in Quick Look and page among each other with ←/→.
  const ready: PreviewFile[] = files.flatMap((af) =>
    af.status === "ready" && af.ref ? [{ path: af.ref.name, name: af.ref.name, chatId }] : [],
  );

  // Always mounted, so the first file slides the row open (`.reveal`) instead of
  // the composer jumping a row taller in one frame.
  return (
    <div className="reveal" data-shut={files.length === 0 || undefined}>
      <div>
        <div className={cn("flex gap-2 overflow-x-auto overflow-y-hidden pb-0.5 scrollbar-thin", className)}>
          {files.map((af, i) => {
            const pf = af.status === "ready" && af.ref ? ready.find((r) => r.path === af.ref!.name) : undefined;
            const { labelKey } = fileKind(af.name);
            const { head, tail } = splitFileName(af.name);
            const size = af.file?.size;
            const failed = af.status === "error";
            return (
              <div
                key={af.id}
                // A staged file arrives with the same pop the finished turn's tiles
                // use, staggered and capped at four steps. Keyed on the file id, so
                // uploading → ready does not re-enter.
                style={{ animationDelay: `${Math.min(i, 4) * 60}ms` }}
                className={cn(
                  "group/chip relative flex h-14 w-[220px] max-w-[220px] shrink-0 animate-pop-in items-center gap-2.5 rounded-xl border bg-card py-1.5 pl-1.5 pr-3",
                  failed ? "border-destructive/60" : "border-border",
                )}
              >
                <span className="relative size-11 shrink-0 overflow-hidden rounded-lg bg-muted">
                  <ChipThumb af={af} file={pf} preview={previews.get(af.id)} />
                  {af.status === "uploading" && (
                    <span aria-hidden className="absolute inset-0 grid place-items-center bg-background/60">
                      <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
                    </span>
                  )}
                  {failed && (
                    // The hint states the failure; the button keeps its own label,
                    // which wins over the hint's, so the action stays announced.
                    <Hint label={t("uploadFailed", { files: af.name })}>
                      <button
                        type="button"
                        onClick={() => onRetry(af.id)}
                        className="absolute inset-0 z-[2] grid place-items-center bg-destructive/20 text-destructive transition hover:bg-destructive/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        aria-label={t("retryUpload", { name: af.name })}
                      >
                        <RotateCw className="size-4" />
                      </button>
                    </Hint>
                  )}
                </span>
                {/* The whole chip opens the file once it is in the sandbox; the
                    filename inside is what names the control. */}
                {pf ? (
                  <button
                    type="button"
                    onClick={() => open(ready, Math.max(0, ready.indexOf(pf)))}
                    className="absolute inset-0 z-[1] rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={af.name}
                  >
                    <span className="sr-only">{af.name}</span>
                  </button>
                ) : (
                  <span className="sr-only">{af.name}</span>
                )}
                <span className="min-w-0 flex-1">
                  {/* Middle truncation: the extension always shows, so
                      report_v1.docx and report_v2.docx stay apart. */}
                  <span aria-hidden className="flex text-sm leading-5 text-foreground">
                    <span className="truncate">{head}</span>
                    <span className="shrink-0 whitespace-pre">{tail}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                    <span aria-hidden className="truncate tabular-nums">
                      {tp(`kind.${labelKey}`)}
                      {size !== undefined ? ` · ${formatSize(size)}` : ""}
                    </span>
                    {/* A paste that became a file gets a way back, as a quiet text
                        action in the chip, so the conversion is never one-way.
                        Above the chip's open control, which covers the rest. */}
                    {onInsertText && isPastedText(af) && (
                      <Hint label={t("pastedAsTextHint")}>
                        <button
                          type="button"
                          onClick={() => onInsertText(af)}
                          className="relative z-[2] shrink-0 rounded-sm font-medium text-muted-foreground underline-offset-2 transition-colors before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {t("pastedAsText")}
                        </button>
                      </Hint>
                    )}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(af.id)}
                  // 20px, under the 24px minimum target: `before:-inset-2` grows the
                  // hit area without moving the dot (WCAG 2.5.8 counts the target).
                  // On a mouse it waits for hover or focus; on touch it is always there.
                  className="absolute -right-1.5 -top-1.5 z-[3] flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm ring-1 ring-border transition before:absolute before:-inset-2 before:content-[''] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-fine:opacity-0 pointer-fine:group-hover/chip:opacity-100 pointer-fine:group-focus-within/chip:opacity-100"
                  aria-label={t("remove", { name: af.name })}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The chip's picture: a photo as itself, a document's first page when the
 *  sandbox can draw it, otherwise the typed sheet. */
function ChipThumb({ af, file, preview }: { af: AttachedFile; file?: PreviewFile; preview?: string }) {
  const [page, setPage] = useState<"loading" | "ok" | "none">("loading");
  if (preview)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={preview} alt="" className="h-full w-full object-cover" />;
  if (file && previewKind(file.name) === "image") return <FileThumb file={file} className="h-full w-full" />;
  const sheet = <BinaryFileThumb name={af.name} className="h-full w-full" />;
  if (!file || !thumbnailable(file.name) || page === "none") return sheet;
  return (
    <>
      {sheet}
      {/* Over the sheet, so a page that never comes (no sandbox running yet)
          leaves the sheet showing; the route answers that with a quiet 204. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/sandbox/files/thumbnail?chatId=${encodeURIComponent(file.chatId ?? "")}&path=${encodeURIComponent(file.path)}`}
        alt=""
        loading="lazy"
        onLoad={() => setPage("ok")}
        onError={() => setPage("none")}
        className={cn(
          "absolute inset-0 h-full w-full bg-white object-cover object-top transition-opacity duration-200 dark:brightness-[.92]",
          page === "ok" ? "opacity-100" : "opacity-0",
        )}
      />
    </>
  );
}
