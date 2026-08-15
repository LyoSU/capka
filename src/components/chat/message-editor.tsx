"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import type { FileRef } from "@/lib/constants";
import { useAttachments } from "./use-attachments";
import { useAutoGrow } from "./use-auto-grow";
import { AttachmentTray } from "./attachment-tray";
import { PASTE_AS_FILE_CHARS, pastedTextFile, uniquelyNamedPaste } from "./chat-input";

/**
 * Rewriting one message — its text AND the files it carries. Used both by a
 * message already in the transcript and by one still waiting in the queue, so
 * the two behave the same: the same keys, the same tray, the same rule about
 * when saving is allowed. They were separate before, and only one of them could
 * edit anything at all.
 *
 * Deliberately NOT a scroller. Opening this changes the transcript's height, and
 * the one thing that may move the transcript is the scroll engine (see the
 * "one writer" guard in `__tests__/pin-scroll`) — the caller hands the height
 * change to it via the disclosure anchor instead.
 */
export function MessageEditor({
  chatId, initialText, initialFiles, onSave, onCancel, autoFocus = true,
}: {
  chatId: string;
  initialText: string;
  initialFiles?: FileRef[];
  onSave: (text: string, refs: FileRef[]) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const t = useTranslations("chat");
  const tCommon = useTranslations("common");
  const isMobile = useIsMobile();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // No `persistKey`: this staging area is as short-lived as the editor. What the
  // message already carries seeds it as not-owned chips, so detaching one stops
  // this message carrying it without deleting a file the transcript still shows.
  const attachments = useAttachments({ chatId, initial: initialFiles });

  // Grow to fit, then scroll inside the cap — and re-measure when the width
  // changes, not only when something is typed. The previous editor grew without
  // any bound at all, so a long paste made a box taller than the screen with its
  // own buttons somewhere below the fold.
  const resize = useAutoGrow(taRef);

  useEffect(() => {
    const el = taRef.current;
    if (!el || !autoFocus) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  const save = () => {
    const text = taRef.current?.value.trim() ?? "";
    // Nothing left to say and nothing to show — treat as a cancel rather than
    // saving an empty message. A files-only message is still a message.
    if (!text && attachments.readyRefs.length === 0) return onCancel();
    if (attachments.hasUploading) return; // guarded by the button too
    onSave(text, attachments.readyRefs);
  };

  return (
    <div className="w-full">
      <div className="overflow-hidden rounded-2xl bg-card shadow-panel focus-within:ring-2 focus-within:ring-primary/40">
        <AttachmentTray
          files={attachments.files}
          chatId={chatId}
          onRemove={attachments.remove}
          onRetry={attachments.retry}
          className="px-3 pt-3"
        />
        <textarea
          ref={taRef}
          defaultValue={initialText}
          onChange={resize}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter saves and Escape cancels — the same pair the editor
            // has always used. Plain Enter stays a newline: an edit is usually a
            // multi-line message being reworked, and on a phone Enter IS the
            // keyboard's newline key, so the buttons are the way out there.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length > 0) {
              e.preventDefault();
              attachments.add(pasted.map(uniquelyNamedPaste));
              return;
            }
            const text = e.clipboardData.getData("text/plain");
            if (text.length >= PASTE_AS_FILE_CHARS) {
              e.preventDefault();
              attachments.add([pastedTextFile(text)]);
            }
          }}
          rows={1}
          // Capped in viewport units so the cap means the same thing on a phone
          // as on a desktop: the box never eats more than a third of the screen.
          // `dvh`, never `vh` — mobile Safari's `vh` ignores the browser chrome,
          // so a third of `vh` is more than a third of what the user can see.
          className="max-h-[33dvh] w-full resize-none bg-transparent px-4 py-3 text-base focus:outline-none md:text-[15px]"
        />
      </div>

      <div className="mt-2 flex items-center justify-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) attachments.add(e.target.files);
            // Reset, or picking the same file twice in a row fires no change.
            e.target.value = "";
          }}
        />
        {/* Left of the confirm pair and visually quieter: adding a file is the
            optional step, saving is the one being confirmed. */}
        <Button
          variant="ghost"
          size="sm"
          className="mr-auto h-9 gap-1.5"
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip className="h-4 w-4" />
          <span className={isMobile ? "sr-only" : undefined}>{t("input.attach")}</span>
        </Button>
        <Button variant="ghost" size="sm" className="h-9" onClick={onCancel}>
          {tCommon("cancel")}
        </Button>
        {/* Held while a file is still in flight, exactly like the composer's send:
            saving now would point the message at a file the sandbox doesn't have
            yet, and the model would be handed a name with nothing behind it. */}
        <Button
          size="sm"
          className="h-9"
          onClick={save}
          disabled={attachments.hasUploading}
          title={attachments.hasUploading ? t("input.uploadingWait") : undefined}
        >
          {tCommon("save")}
        </Button>
      </div>
    </div>
  );
}
