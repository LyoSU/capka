"use client";

import { useRef, useCallback, useMemo, useEffect, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, Loader2, Paperclip, RotateCw, Square, X } from "lucide-react";
import { ContextMeter } from "@/components/chat/context-meter";
import { useIsMobile, MOBILE_BREAKPOINT } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { BinaryFileThumb, FileTile, SandboxFileTile, type PreviewFile } from "./file-preview";
import type { FileRef } from "@/lib/constants";

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

/**
 * A composer attachment. Uploaded eagerly on attach, so it carries its own
 * lifecycle: `uploading` while in flight, `ready` once it's in the sandbox (with
 * its server `ref`), or `error` (retryable). `file` holds the local bytes for a
 * freshly-staged attachment; it's absent for one restored from a saved draft,
 * where only the `ref` survives and the thumbnail comes from the sandbox.
 */
export type AttachedFile = {
  id: string;
  status: "uploading" | "ready" | "error";
  name: string;
  type: string;
  file?: File;
  ref?: FileRef;
};

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isLoading: boolean;
  /** A card above is awaiting the user — a `manage` approval or an `ask` question.
   *  Block the composer (like Claude Code) so the card is the only next action. */
  awaitingInput?: boolean;
  chatId: string;
  files: AttachedFile[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (id: string) => void;
  onRetryFile: (id: string) => void;
  /** Context-window fill, shown as a ring left of the send button. */
  contextUsage?: { used: number; window: number } | null;
  /** Fresh, empty chat — focus the composer on mount so it's ready to type. */
  isNewChat: boolean;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
  awaitingInput = false,
  chatId,
  files,
  onAddFiles,
  onRemoveFile,
  onRetryFile,
  contextUsage,
  isNewChat,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const isMobile = useIsMobile();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Thumbnails for locally-staged image attachments (uploading / error), so a
  // photo is obviously a photo before it lands in the sandbox. Ready chips render
  // their thumbnail straight from the sandbox instead, so they need no object-URL.
  const previews = useMemo(() => {
    const m = new Map<string, string>();
    for (const af of files) {
      if (af.file && af.file.type.startsWith("image/")) m.set(af.id, URL.createObjectURL(af.file));
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

  // Keep the textarea height in sync with `value` on EVERY change, not just on
  // keystrokes. After a send the parent resets `value` to "" programmatically
  // (and a restored draft sets it on mount) — neither fires the textarea's
  // onChange, so without this the box stays stuck at its grown-out height.
  useEffect(() => {
    resize();
  }, [value, resize]);

  // Land the caret in the composer when a chat opens. Desktop: always — the
  // keyboard is physical, so focus costs nothing. Mobile: only for a fresh chat,
  // since raising the on-screen keyboard over an existing thread would cover the
  // conversation the user came to read. We read matchMedia directly rather than
  // `isMobile`, because the hook reports `false` until its own effect resolves —
  // so a mount-time `autoFocus` prop would focus on mobile before we knew it was
  // mobile, popping the keyboard on every open. Keyed on `chatId` so switching
  // threads re-evaluates.
  useEffect(() => {
    const isMobileNow = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches;
    if (!isMobileNow || isNewChat) textareaRef.current?.focus();
  }, [chatId, isNewChat]);

  // Something is uploading → hold the send until it settles, so we never send a
  // message whose attachment isn't in the sandbox yet.
  const uploading = files.some((f) => f.status === "uploading");
  const hasReady = files.some((f) => f.status === "ready");
  const hasContent = Boolean(value.trim()) || hasReady;
  // A pending card (approval or question) hard-blocks sending — the user must act
  // on the card first.
  const canSend = hasContent && !uploading && !awaitingInput;

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // On mobile, Enter is the on-screen keyboard's newline — sending happens via
    // the button instead (the hardware-keyboard convenience of Enter-to-send only
    // makes sense on a physical keyboard). `isComposing` guards an IME mid-word:
    // pressing Enter to confirm a composition must not fire the send.
    if (e.key === "Enter" && !e.shiftKey && !isMobile && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Allow sending while a reply streams — the message queues and runs after
      // the current turn (serialized per chat on the server).
      if (canSend) onSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pastedFiles = Array.from(e.clipboardData.files);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      onAddFiles(pastedFiles);
      return;
    }
    // Big text paste → .txt attachment, so a wall of text doesn't flood the input.
    const text = e.clipboardData.getData("text/plain");
    if (text.length >= PASTE_AS_FILE_CHARS) {
      e.preventDefault();
      onAddFiles([pastedTextFile(text)]);
    }
  };

  const removeButton = (af: AttachedFile) => (
    <button
      type="button"
      onClick={() => onRemoveFile(af.id)}
      className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background shadow-sm ring-2 ring-card transition before:absolute before:-inset-2.5 before:content-[''] hover:bg-foreground/80"
      aria-label={t("remove", { name: af.name })}
    >
      <X className="h-3 w-3" />
    </button>
  );

  return (
    <div className="px-4 md:px-6 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-3xl lg:max-w-4xl">
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm transition-all focus-within:shadow-md">
          {/* Attached files preview — same square FileTile used in chat history, so
              a staged file looks identical to a sent one. A ready file shows its
              real sandbox thumbnail; one still uploading (or failed) shows its local
              preview with a status overlay. Wraps and scrolls so many files never
              push the textarea off-screen. */}
          {files.length > 0 && (
            <div className="flex max-h-44 flex-wrap gap-3 overflow-y-auto px-3 pt-3 scrollbar-thin">
              {files.map((af) => {
                // Ready & in the sandbox → real thumbnail tile (works for restored
                // chips too, whose bytes are no longer in memory).
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
                        onClick={() => onRetryFile(af.id)}
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
                      <div
                        aria-hidden
                        className="absolute inset-0 z-[1] grid place-items-center rounded-xl bg-background/55"
                      >
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    </>
                  );

                return <FileTile key={af.id} thumb={thumb} name={af.name} overlay={overlay} />;
              })}
            </div>
          )}

          <div className="relative mx-4 mt-3 mb-1 max-h-52 overflow-y-auto scrollbar-thin">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                resize();
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={awaitingInput}
              aria-label={files.length > 0 ? t("placeholderFiles") : t("placeholder")}
              rows={1}
              className="w-full resize-none overflow-hidden bg-transparent pr-2 text-base leading-relaxed focus-visible:outline-none disabled:opacity-60 md:text-[15px]"
            />
            {/* Overlay placeholder instead of the native one: a textarea's own
                placeholder wraps to a second line on a narrow screen and can't be
                ellipsised. This single-line, truncating span never does. */}
            {!value && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 truncate pr-2 text-base leading-relaxed text-muted-foreground md:text-[15px]"
              >
                {awaitingInput ? t("awaitingInput") : files.length > 0 ? t("placeholderFiles") : t("placeholder")}
              </span>
            )}
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
                  if (e.target.files) onAddFiles(e.target.files);
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

            {/* Right cluster: context-window ring, then Send/Stop. Grouping them
                keeps the ring just left of the button (the row is justify-between,
                so a loose ring would drift to the centre). */}
            <div className="flex items-center gap-2">
              {contextUsage && <ContextMeter used={contextUsage.used} window={contextUsage.window} />}

              {/* While a reply streams: Send (queues the next turn) when there's
                  something to send, otherwise Stop. Idle: always Send. Send stays
                  disabled until any in-flight upload settles. */}
              {isLoading && !hasContent ? (
                <Button
                  size="icon"
                  variant="outline"
                  className="h-10 w-10 sm:h-8 sm:w-8 shrink-0 rounded-xl transition-transform active:scale-90"
                  // Keep the caret in the composer — a button click would otherwise
                  // steal focus (and close the mobile keyboard) on every send/stop.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onStop}
                  aria-label={t("stop")}
                >
                  <Square className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className="group/send h-10 w-10 sm:h-8 sm:w-8 shrink-0 rounded-xl transition-transform active:scale-90"
                  disabled={!canSend}
                  // Keep the caret in the composer — a button click would otherwise
                  // steal focus (and close the mobile keyboard) on every send.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onSubmit}
                  aria-label={isLoading ? t("queue") : t("send")}
                >
                  {uploading ? (
                    <Loader2 className="h-4.5 w-4.5 animate-spin sm:h-4 sm:w-4" />
                  ) : (
                    <ArrowUp className="h-4.5 w-4.5 transition-transform group-hover/send:-translate-y-0.5 sm:h-4 sm:w-4" />
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
