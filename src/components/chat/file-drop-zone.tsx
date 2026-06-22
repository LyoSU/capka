"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Upload } from "lucide-react";

/**
 * Full-window file drop target. Listens on `window` so a file dragged anywhere
 * over the chat — the new-chat greeting or the message stream — is accepted, not
 * just the composer box. Shows a soft overlay while a file drag is in progress.
 */
export function FileDropZone({
  onFiles,
  disabled,
}: {
  onFiles: (files: FileList) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("chat.input");
  const [active, setActive] = useState(false);
  // dragenter/dragleave fire once per child element crossed, so track nesting
  // depth and only drop the overlay once we've genuinely left the window.
  const depth = useRef(0);
  // Keep the latest handler in a ref so the window listeners bind once and never
  // go stale, even though onFiles changes identity as the staged file list grows.
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    if (disabled) return;
    // Only react to real file drags — ignore dragged text, links, selections.
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // preventDefault on dragover is what makes the window a valid drop target.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      if (e.dataTransfer?.files.length) onFilesRef.current(e.dataTransfer.files);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [disabled]);

  if (!active) return null;

  return (
    <div className="animate-in fade-in pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm duration-150">
      <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary/50 bg-card/80 px-10 py-8 text-center shadow-lg">
        <Upload className="h-8 w-8 text-primary" />
        <p className="text-base font-medium text-foreground">{t("dropHere")}</p>
      </div>
    </div>
  );
}
