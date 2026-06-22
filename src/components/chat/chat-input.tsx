"use client";

import { useRef, useCallback, useMemo, useEffect, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BinaryFileThumb, FileTile } from "./file-preview";
import { useFileAttach } from "./use-file-attach";

/**
 * Pasted plain text at or above this length becomes a .txt attachment instead of
 * landing inline in the textarea — same as Claude. Keeps the composer readable
 * when someone dumps a log, a long doc, or a big code block.
 */
const PASTE_AS_FILE_CHARS = 2000;

/** Turn a big paste into a named .txt File. Timestamped so repeat pastes don't collide. */
function pastedTextFile(text: string): File {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "-"); // HH-MM-SS
  return new File([text], `pasted-text-${stamp}.txt`, { type: "text/plain" });
}

export type AttachedFile = {
  file: File;
  id: string;
};

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isLoading: boolean;
  files: AttachedFile[];
  onFilesChange: (files: AttachedFile[]) => void;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
  files,
  onFilesChange,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFiles = useFileAttach(files, onFilesChange);

  // Thumbnails for image attachments so a photo is obviously a photo.
  const previews = useMemo(() => {
    const m = new Map<string, string>();
    for (const af of files) {
      if (af.file.type.startsWith("image/")) m.set(af.id, URL.createObjectURL(af.file));
    }
    return m;
  }, [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Allow sending while a reply streams — the message queues and runs after
      // the current turn (serialized per chat on the server).
      if (value.trim() || files.length > 0) {
        onSubmit();
      }
    }
  };

  const removeFile = (id: string) => {
    onFilesChange(files.filter((f) => f.id !== id));
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pastedFiles = Array.from(e.clipboardData.files);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      addFiles(pastedFiles);
      return;
    }
    // Big text paste → .txt attachment, so a wall of text doesn't flood the input.
    const text = e.clipboardData.getData("text/plain");
    if (text.length >= PASTE_AS_FILE_CHARS) {
      e.preventDefault();
      addFiles([pastedTextFile(text)]);
    }
  };

  const hasContent = value.trim() || files.length > 0;

  return (
    <div className="px-4 md:px-6 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-3xl lg:max-w-4xl">
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm transition-all focus-within:shadow-md">
          {/* Attached files preview — same square FileTile used in chat history,
              so a staged file looks identical to a sent one. Files aren't in the
              sandbox yet, so the thumb is a local object-URL / typed icon. Wraps
              and scrolls so many files never push the textarea off-screen. */}
          {files.length > 0 && (
            <div className="flex max-h-44 flex-wrap gap-3 overflow-y-auto px-3 pt-3 scrollbar-thin">
              {files.map((af) => {
                const preview = previews.get(af.id);
                const thumb = preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="" className="h-full w-full object-cover" />
                ) : (
                  <BinaryFileThumb name={af.file.name} className="h-full w-full" />
                );
                return (
                  <FileTile
                    key={af.id}
                    thumb={thumb}
                    name={af.file.name}
                    overlay={
                      <button
                        type="button"
                        onClick={() => removeFile(af.id)}
                        className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background shadow-sm ring-2 ring-card transition hover:bg-foreground/80"
                        aria-label={t("remove", { name: af.file.name })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    }
                  />
                );
              })}
            </div>
          )}

          <div className="mx-4 mt-3 mb-1 max-h-52 overflow-y-auto scrollbar-thin">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                resize();
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={files.length > 0 ? t("placeholderFiles") : t("placeholder")}
              rows={1}
              className="w-full resize-none overflow-hidden bg-transparent pr-2 text-base leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none md:text-[15px]"
            />
          </div>
          <div className="flex items-center justify-between px-3 pb-2.5">
            {/* Attach button */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 sm:h-8 sm:w-8 rounded-xl text-muted-foreground transition-transform hover:text-foreground active:scale-90"
                onClick={() => fileInputRef.current?.click()}
                title={t("attach")}
                aria-label={t("attach")}
              >
                <Paperclip className="h-4.5 w-4.5 sm:h-4 sm:w-4" />
              </Button>
            </div>

            {/* While a reply streams: Send (queues the next turn) when there's
                something to send, otherwise Stop. Idle: always Send. */}
            {isLoading && !hasContent ? (
              <Button
                size="icon"
                variant="outline"
                className="h-10 w-10 sm:h-8 sm:w-8 shrink-0 rounded-xl transition-transform active:scale-90"
                onClick={onStop}
                aria-label={t("stop")}
              >
                <Square className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="group/send h-10 w-10 sm:h-8 sm:w-8 shrink-0 rounded-xl transition-transform active:scale-90"
                disabled={!hasContent}
                onClick={onSubmit}
                aria-label={isLoading ? t("queue") : t("send")}
              >
                <ArrowUp className="h-4.5 w-4.5 transition-transform group-hover/send:-translate-y-0.5 sm:h-4 sm:w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
