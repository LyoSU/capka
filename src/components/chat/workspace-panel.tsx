"use client";

import { useIsMobile } from "@/hooks/use-mobile";
import { useBackDismiss } from "@/hooks/use-back-dismiss";
import { cn } from "@/lib/utils";
import { chatTarget } from "@/lib/workspace-target";
import { WorkspaceBrowser } from "./workspace-browser";
import type { useFolderSync } from "./use-folder-sync";

// The chat's sliding workspace panel: the shared WorkspaceBrowser (addressed at
// this chat) wrapped in the right-edge sheet that grows in on desktop and slides
// over on mobile. All the file logic lives in WorkspaceBrowser, which the project
// hub's Files tab reuses with a project target.

export function WorkspacePanel({
  chatId,
  open,
  onClose,
  running,
  revision,
  folderSync,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
  running: boolean;
  revision: number;
  folderSync?: ReturnType<typeof useFolderSync>;
}) {
  const isMobile = useIsMobile();
  // On phones the panel is a full-screen sheet, so the Back gesture should close
  // it rather than leave the chat.
  useBackDismiss(open && isMobile, onClose);

  // Always mounted so open/close can animate. On mobile it's a fixed overlay that
  // slides in from the right; on desktop it's a flex item that grows from 0 → 20rem,
  // pushing the chat smoothly instead of popping in. justify-end pins the inner
  // fixed-width column to the panel's right edge so the chat slides aside to reveal
  // it in place instead of the column riding the left edge and getting clipped.
  return (
    <aside
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "z-40 flex h-full shrink-0 justify-end overflow-hidden border-l bg-card shadow-lg transition-[width,transform] duration-300 ease-out",
        "fixed inset-y-0 right-0 w-full md:static md:z-auto md:w-80 md:shadow-none",
        open
          ? "translate-x-0 md:w-80"
          : "pointer-events-none translate-x-full md:w-0 md:translate-x-0 md:border-l-0",
      )}
    >
      <WorkspaceBrowser
        className="md:w-80 md:shrink-0"
        target={chatTarget(chatId)}
        active={open}
        running={running}
        revision={revision}
        folderSync={folderSync}
        onClose={onClose}
      />
    </aside>
  );
}
