"use client";

import { useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { X, RotateCw, Loader2 } from "lucide-react";
import { FileTile, SandboxFileTile, BinaryFileThumb, type PreviewFile } from "./file-preview";
import type { AttachedFile } from "./chat-input";

/**
 * The files staged for one message: the same square tiles used everywhere else a
 * file appears, so a file being attached looks like the file it will become.
 *
 * Shared by the composer and by both message editors — the tile, the ×, the
 * upload spinner and the retry-on-failure are one implementation, because three
 * copies of "what a half-uploaded file looks like" is three chances to disagree.
 */
export function AttachmentTray({
  files, chatId, onRemove, onRetry, className,
}: {
  files: AttachedFile[];
  chatId: string;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  className?: string;
}) {
  const t = useTranslations("chat.input");

  // Thumbnails for locally-staged images (uploading / error), so a photo is
  // obviously a photo before it lands in the sandbox. Ready chips render their
  // thumbnail straight from the sandbox instead, so they need no object-URL.
  const previews = useMemo(() => {
    const m = new Map<string, string>();
    for (const af of files) {
      if (af.file && af.file.type.startsWith("image/")) m.set(af.id, URL.createObjectURL(af.file));
    }
    return m;
  }, [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  if (files.length === 0) return null;

  const removeButton = (af: AttachedFile) => (
    <button
      type="button"
      onClick={() => onRemove(af.id)}
      // The dot is 20px, which is under the 24px minimum target — `before:-inset-2.5`
      // grows the hit area to ~40px without moving the dot, which is what makes it
      // usable with a thumb (WCAG 2.5.8 counts the target, not the paint).
      className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background shadow-sm ring-2 ring-card transition before:absolute before:-inset-2.5 before:content-[''] hover:bg-foreground/80"
      aria-label={t("remove", { name: af.name })}
    >
      <X className="h-3 w-3" />
    </button>
  );

  return (
    // Wraps and scrolls, so many files never push the message body off-screen.
    <div className={`flex max-h-44 flex-wrap gap-3 overflow-y-auto scrollbar-thin ${className ?? ""}`}>
      {files.map((af) => {
        // Ready & in the sandbox → real thumbnail tile (works for restored chips
        // too, whose bytes are no longer in memory).
        if (af.status === "ready" && af.ref) {
          const pf: PreviewFile = { path: af.ref.name, name: af.ref.name, chatId };
          return <SandboxFileTile key={af.id} file={pf} viewable={[pf]} overlay={removeButton(af)} />;
        }

        const preview = previews.get(af.id);
        const thumb = preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <BinaryFileThumb name={af.name} className="h-full w-full" />
        );

        // Uploading → dim + spinner; error → dim + retry, with a red ring.
        const overlay =
          af.status === "error" ? (
            <>
              {removeButton(af)}
              <button
                type="button"
                onClick={() => onRetry(af.id)}
                className="absolute inset-0 z-[1] grid place-items-center rounded-xl bg-destructive/25 text-destructive-foreground ring-1 ring-destructive transition hover:bg-destructive/35"
                aria-label={t("retryUpload", { name: af.name })}
                title={t("uploadFailed", { files: af.name })}
              >
                <RotateCw className="h-5 w-5" />
              </button>
            </>
          ) : (
            <>
              {removeButton(af)}
              <div aria-hidden className="absolute inset-0 z-[1] grid place-items-center rounded-xl bg-background/55">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            </>
          );

        return <FileTile key={af.id} thumb={thumb} name={af.name} overlay={overlay} />;
      })}
    </div>
  );
}
