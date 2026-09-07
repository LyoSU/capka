"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { MOBILE_BREAKPOINT, useIsMobile } from "@/hooks/use-mobile";
import { useBackDismiss } from "@/hooks/use-back-dismiss";
import { RESIZE_HANDLE_CLASS, useResizableWidth } from "@/hooks/use-resizable-width";
import { clearPreviewPath, readChatLayout, writeChatLayout } from "@/hooks/use-chat-layout";
import { cn } from "@/lib/utils";
import { chatTarget } from "@/lib/workspace-target";
import { WorkspaceBrowser } from "./workspace-browser";
import { DockedPreview, probeFile, usePreview, usePreviewDock } from "./file-preview";
import { PreviewSelectionActions } from "./selection-actions";
import type { useFolderSync } from "./use-folder-sync";

// The chat's sliding workspace panel: the shared WorkspaceBrowser (addressed at
// this chat) wrapped in the right-edge sheet that grows in on desktop and slides
// over on mobile. All the file logic lives in WorkspaceBrowser, which the project
// hub's Files tab reuses with a project target.
//
// On desktop this column is also where a previewed file opens — the browser steps
// aside for the viewer rather than a dialog covering the conversation the file was
// produced for. See DockedPreview in file-preview.tsx.

/** What the conversation keeps for itself, in px (28rem). The panel may take the
 *  rest of the row and no more: the chat is what the panel is a panel *of*. */
const CHAT_FLOOR = 448;

export function WorkspacePanel({
  chatId,
  open,
  onOpen,
  onClose,
  running,
  revision,
  folderSync,
  onPrompt,
}: {
  chatId: string;
  open: boolean;
  /** Called when something outside asks the panel to appear — opening a file
   *  preview, which docks here. */
  onOpen?: () => void;
  onClose: () => void;
  running: boolean;
  revision: number;
  folderSync?: ReturnType<typeof useFolderSync>;
  /** Fills the composer, for the quote actions in the docked text viewer. */
  onPrompt?: (text: string) => void;
}) {
  const t = useTranslations("chat.workspace");
  const isMobile = useIsMobile();
  const ref = useRef<HTMLElement>(null);
  // On phones the panel is a full-screen sheet, so the Back gesture should close
  // it rather than leave the chat.
  useBackDismiss(open && isMobile, onClose);

  // Register as the host for file previews. On a phone nothing docks and the
  // provider keeps its dialog; the hook itself is what tells it a host exists.
  const dock = usePreviewDock(onOpen);
  const preview = dock?.state ?? null;
  const dockClose = dock?.close;

  // Closing the column puts the preview away with it — re-opening Files should
  // show the files, not the document someone was reading before lunch.
  useEffect(() => {
    if (!open) dockClose?.();
  }, [open, dockClose]);

  // ── Where this chat's chrome was left ──────────────────────────────────────
  //
  // Restored on mount, not on first render: the server has no localStorage, so
  // deciding the panel is open before hydration would be a mismatch. Keyed by the
  // chat, so the answer follows the conversation rather than the tab.
  const { open: openPreview } = usePreview();
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  // `onOpen`/`onClose` are fresh arrows every render of the parent; the restore
  // must not re-run because of that.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let alive = true;
    // Unblocks the write below for THIS chat. A bare boolean would let the
    // previous chat's state be written under the new chat's id on a navigation
    // that doesn't remount.
    setHydratedFor(chatId);
    // Desktop only, and read straight from the media query rather than from
    // `useIsMobile`: that hook reports false until its own effect has run, which
    // is this same commit. On a phone the column and the viewer are overlays that
    // COVER the conversation — restoring one would land the reader on a file list
    // instead of the chat they opened.
    if (window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches) return;

    const stored = readChatLayout(chatId);
    // Both ways round: arriving at a chat that was left shut has to shut the
    // column, or it rides in from whichever chat was open before.
    if (stored?.workspaceOpen) onOpenRef.current?.();
    else onCloseRef.current();

    const path = stored?.previewPath;
    if (!path) return;
    // The file may be gone: a workspace is scratch space. Ask before opening a
    // viewer onto nothing — and only a definite 404 forgets the path, because a
    // controller that is merely down would otherwise erase a good one.
    void (async () => {
      const file = { path, name: path.split("/").pop() || path, chatId };
      const verdict = await probeFile(file);
      if (!alive) return;
      if (verdict === "ok") {
        onOpenRef.current?.();
        openPreview([file], 0);
      } else if (verdict === "gone") {
        clearPreviewPath(chatId);
      }
    })();
    return () => {
      alive = false;
    };
  }, [chatId, openPreview]);

  const previewPath = preview?.files[preview.index]?.path ?? null;
  useEffect(() => {
    if (hydratedFor !== chatId) return;
    writeChatLayout(chatId, { workspaceOpen: open, previewPath });
  }, [hydratedFor, chatId, open, previewPath]);

  // Highlight-to-quote inside an open file. Built here rather than in the viewer:
  // this column is the only host of one that has a composer to quote into, and a
  // component naming a namespace pulls those strings into every route that can
  // reach it — the viewer is also opened from settings.
  const selectionBar = useCallback(
    (fileName: string) =>
      onPrompt ? <PreviewSelectionActions fileName={fileName} onPrompt={onPrompt} /> : null,
    [onPrompt],
  );

  const resize = useResizableWidth({
    storageKey: "capka.layout.workspace",
    defaultWidth: 320,
    min: 320,
    // The row this panel sits in is exactly the window minus the nav, whatever
    // width the nav currently has — so measuring the parent answers "how much is
    // there to share" without having to know anything about the sidebar.
    maxWidth: () => {
      const row = ref.current?.parentElement?.clientWidth ?? window.innerWidth;
      return Math.min(window.innerWidth * 0.6, row - CHAT_FLOOR);
    },
    label: t("resize"),
    direction: -1,
    // Same gesture as the nav's, mirrored: shoved hard into the right edge, the
    // column shuts rather than grinding against its 20rem floor. Closing it also
    // clears the docked preview, through the effect above.
    onCollapse: onClose,
  });

  // Always mounted so open/close can animate. On mobile it's a fixed overlay that
  // slides in from the right; on desktop it's a flex item that grows from 0 → its
  // remembered width, pushing the chat smoothly instead of popping in. justify-end
  // pins the inner fixed-width column to the panel's right edge so the chat slides
  // aside to reveal it in place instead of the column riding the left edge and
  // getting clipped.
  return (
    <aside
      ref={ref}
      aria-hidden={!open}
      inert={!open}
      // The width lives in a variable rather than on the element so the inner
      // column can match it at the same breakpoint, and so the closed state stays
      // a plain class instead of a JS branch that would guess wrong before hydration.
      style={{ "--workspace-w": `${resize.width}px` } as React.CSSProperties}
      className={cn(
        // Two different things wear one component. On a phone it's a sheet that
        // covers the chat, so it takes the `overlay` rung and has to read as ON TOP.
        // On desktop it docks and PUSHES the chat aside, sharing the plane — a
        // shadow there would claim a depth it doesn't have, so the seam is a
        // hairline instead. But it was `--border`, the quiet in-surface divider,
        // which left the pane looking like nothing had opened; `--border-strong` is
        // the token for an edge that has to hold against the page.
        "relative z-40 flex h-full shrink-0 justify-end overflow-hidden border-l bg-card shadow-overlay transition-[width,transform] duration-300 ease-out",
        "fixed inset-y-0 right-0 w-full md:static md:z-auto md:w-(--workspace-w) md:border-l-border-strong md:shadow-none",
        open
          ? "translate-x-0"
          : "pointer-events-none translate-x-full md:w-0 md:translate-x-0 md:border-l-0",
        // Chasing the pointer 300ms late reads as a broken drag, not a smooth one.
        resize.dragging && "transition-none",
      )}
    >
      {/* Inside the panel, not straddling its border: the box clips its own
          overflow so the sliding animation doesn't leak, and half a handle would
          be the half that gets cut. */}
      {open && (
        <div {...resize.handleProps} className={cn(RESIZE_HANDLE_CLASS, "absolute inset-y-0 left-0")} />
      )}
      {/* The browser stays mounted under the viewer so coming back lands in the
          folder you left, not at the workspace root. */}
      <WorkspaceBrowser
        className={cn("md:w-(--workspace-w) md:shrink-0", preview && "hidden")}
        target={chatTarget(chatId)}
        active={open && !preview}
        running={running}
        revision={revision}
        folderSync={folderSync}
        onClose={onClose}
      />
      {preview && dock && (
        <DockedPreview
          className="md:w-(--workspace-w) md:shrink-0"
          files={preview.files}
          index={preview.index}
          onIndex={dock.setIndex}
          onBack={dock.close}
          onClose={onClose}
          selectionBar={selectionBar}
        />
      )}
    </aside>
  );
}
