"use client";

import { useRef, useEffect, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, Info, Loader2, Paperclip, Square } from "lucide-react";
import { ContextMeter } from "@/components/chat/context-meter";
import { AttachFolderMenu } from "@/components/chat/attach-folder-menu";
import { useIsMobile, MOBILE_BREAKPOINT } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { AttachmentTray } from "@/components/chat/attachment-tray";
import { useAutoGrow } from "@/components/chat/use-auto-grow";
import type { FileRef } from "@/lib/constants";
import type { Modality } from "@/lib/providers/registry";
import type { useFolderSync } from "@/components/chat/use-folder-sync";

/**
 * Pasted plain text at or above this length becomes a .txt attachment instead of
 * landing inline in the textarea — same as Claude. Keeps the composer readable
 * when someone dumps a log, a long doc, or a big code block.
 */
export const PASTE_AS_FILE_CHARS = 2000;

/** Turn a big paste into a named .txt File. Timestamped so repeat pastes don't collide. */
export function pastedTextFile(text: string): File {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "-"); // HH-MM-SS
  return new File([text], `pasted-text-${stamp}.txt`, { type: "text/plain" });
}

/**
 * Clipboard screenshots all arrive named "image.png" (or blank), so repeat pastes
 * collide: the sandbox writes them to the same path (second overwrites first) and
 * the dedup-by-name persistence treats them as one file. Give each pasted image a
 * unique name so two screenshots stay two separate attachments. A copied *file*
 * (from Finder/Explorer) carries a real name — leave those untouched.
 */
export function uniquelyNamedPaste(file: File): File {
  // Only clipboard bitmaps ("image.png"/blank) need a name; real files keep theirs.
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const ext = /\.\w+$/.exec(file.name)?.[0] ?? (file.type.startsWith("image/") ? `.${file.type.slice(6)}` : "");
  // HH-MM-SS + a short random suffix, so two pastes in the same second stay distinct.
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "-");
  return new File([file], `pasted-image-${stamp}-${Math.random().toString(36).slice(2, 5)}${ext}`, { type: file.type });
}

/**
 * A composer attachment. Uploaded eagerly on attach, so it carries its own
 * lifecycle: `uploading` while in flight, `ready` once it's in the sandbox (with
 * its server `ref`), or `error` (retryable). `file` holds the local bytes for a
 * freshly-staged attachment; it's absent for one restored from a saved draft,
 * where only the `ref` survives and the thumbnail comes from the sandbox.
 *
 * `owned` marks a file THIS staging area uploaded, as opposed to one that came
 * with a message being edited. Only an owned file is deleted from the sandbox
 * when it's detached: the other kind is still referenced by the transcript.
 */
export type AttachedFile = {
  id: string;
  status: "uploading" | "ready" | "error";
  name: string;
  type: string;
  file?: File;
  ref?: FileRef;
  owned?: boolean;
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
  /** Media modalities among the *staged* attachments that the currently-picked
   *  model can't read natively (image/pdf/audio/video). Drives a quiet heads-up
   *  under the file tiles at attach time — so the user learns the model is blind
   *  to a file *before* sending, not after, and can switch the model that's
   *  already sitting right there in the picker. Empty/undefined → no hint. */
  blindModalities?: Modality[];
  /** Context-window fill, shown as a ring left of the send button. */
  contextUsage?: { used: number; window: number } | null;
  /** PC-folder sync state + actions. When the user may attach a folder, the
   *  paperclip becomes a small menu (Upload files / Connect a folder). */
  folders?: ReturnType<typeof useFolderSync>;
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
  blindModalities,
  contextUsage,
  folders,
}: ChatInputProps) {
  const t = useTranslations("chat.input");
  const tNotice = useTranslations("chat.notice");
  const isMobile = useIsMobile();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Bounded autogrow, shared with the message editor — it also re-measures on
  // width changes, which is what a rotation or the sidebar opening does to a box
  // whose height was computed for a different line count.
  const resize = useAutoGrow(textareaRef, value);


  // Land the caret in the composer when a chat opens — DESKTOP ONLY, where the
  // keyboard is physical so focus costs nothing. We never auto-focus on mobile,
  // not even a fresh chat: this effect re-runs on any page-lifecycle remount
  // (e.g. a PWA resuming from the background reloads the tab), so focusing here
  // would pop the on-screen keyboard every time the user returns to the app.
  // matchMedia is read directly rather than via `isMobile`, since the hook
  // reports `false` until its own effect resolves. Keyed on `chatId` so
  // switching threads re-evaluates.
  useEffect(() => {
    const isMobileNow = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches;
    if (!isMobileNow) textareaRef.current?.focus();
  }, [chatId]);

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
      onAddFiles(pastedFiles.map(uniquelyNamedPaste));
      return;
    }
    // Big text paste → .txt attachment, so a wall of text doesn't flood the input.
    const text = e.clipboardData.getData("text/plain");
    if (text.length >= PASTE_AS_FILE_CHARS) {
      e.preventDefault();
      onAddFiles([pastedTextFile(text)]);
    }
  };


  return (
    // `data-print="hide"`: an empty input box is the one thing on this screen that
    // is pure interface — it says nothing on paper and would eat a third of the
    // last page.
    <div data-print="hide" className="px-4 md:px-6 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-3xl lg:max-w-4xl">
        {/* The composer is the one place on this screen the user acts, so it sits a
            rung above the transcript and rises one more on focus — "here is where
            you type" stated by depth instead of by a label. `border` is gone
            because `shadow-raised` carries its own hairline as the shadow's first
            layer; keeping both drew a doubled 2px edge. */}
        <div className="overflow-hidden rounded-2xl bg-card shadow-raised transition-micro focus-within:shadow-overlay">
          {/* Attached files preview — same square FileTile used in chat history, so
              a staged file looks identical to a sent one. A ready file shows its
              real sandbox thumbnail; one still uploading (or failed) shows its local
              preview with a status overlay. Wraps and scrolls so many files never
              push the textarea off-screen. */}
          {/* Attached files preview — the same tray both message editors use, so
              a file being attached looks identical wherever it is attached. */}
          <AttachmentTray
            files={files}
            chatId={chatId}
            onRemove={onRemoveFile}
            onRetry={onRetryFile}
            className="px-3 pt-3"
          />

          {/* Quiet heads-up when the picked model can't read a staged file's
              media type natively. Deliberately understated — muted text, an info
              glyph, no button — because the model picker is already a tap away in
              this very composer, and the file still reaches the sandbox either
              way. Just so the user isn't surprised after sending. */}
          {blindModalities && blindModalities.length > 0 && (
            <div className="flex items-center gap-1.5 px-3.5 pt-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span>
                {t("blindModalities", {
                  modalities: blindModalities.map((m) => tNotice(`modality.${m}`)).join(", "),
                })}
              </span>
            </div>
          )}

          <div className="relative mx-4 mt-3 mb-1">
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
              // The textarea is its OWN scroller (max-height + overflow toggled
              // in `resize`), not an overflow-hidden box inside a scrolling
              // wrapper. When the
              // element that scrolls is also the one holding the caret, the
              // browser keeps the caret in view natively; the old wrapper-scrolls
              // arrangement had `resize()` collapse the textarea to height 0 each
              // keystroke, which clamped the wrapper's scrollTop to 0 and jumped
              // long text back to the top on every character.
              className="w-full resize-none max-h-52 overflow-y-hidden scrollbar-thin bg-transparent pr-2 text-base leading-relaxed focus-visible:outline-none disabled:opacity-60 md:text-[15px]"
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
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            {/* Attach button */}
            <div className="shrink-0">
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
              {folders?.canAttach ? (
                // Folder access is on for this user → the paperclip opens a small
                // menu (upload files vs connect a folder from their computer).
                <AttachFolderMenu folders={folders} onUpload={() => fileInputRef.current?.click()}>
                  <span
                    className="inline-flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-xl text-muted-foreground transition-transform hover:text-foreground active:scale-90"
                    title={t("attach")}
                    aria-label={t("attach")}
                  >
                    <Paperclip className="h-4.5 w-4.5 sm:h-4 sm:w-4" />
                  </span>
                </AttachFolderMenu>
              ) : (
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
              )}
            </div>

            {/* Right cluster: context-window ring, then Send/Stop. Grouping them
                keeps the ring just left of the button, so a loose ring can't drift
                toward the centre. */}
            <div className="flex shrink-0 items-center gap-2">
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
