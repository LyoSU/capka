"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { ChatContextMenu, type ChatItem } from "./chat-context-menu";

/**
 * The chat panel's ⋯ — rename, pin, archive, move, export, share, delete for the
 * conversation you are actually reading.
 *
 * Every one of those already exists on the sidebar's row menu, and this is the
 * same component: the panel simply has no row to borrow the record from, so it
 * fetches one. Lazily, on the first open — the overwhelming majority of chats are
 * read and never administered, and a request per chat load would buy nothing.
 *
 * An edit here changes the row the sidebar is showing, so it says so on the
 * window and the list re-reads. A CustomEvent rather than a shared store because
 * the two components have no common owner short of the dashboard layout.
 */
export function ChatMenuButton({ chatId }: { chatId: string }) {
  const t = useTranslations("chat");
  const [chat, setChat] = useState<ChatItem | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Set while a first fetch is in flight, so the click that started it still ends
  // with the menu open rather than silently doing nothing.
  const wantOpen = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (!res.ok) return;
      const row = (await res.json()) as ChatItem;
      setChat(row);
      if (wantOpen.current) {
        wantOpen.current = false;
        setMenuOpen(true);
      }
    } catch {
      // The button simply doesn't open. Nothing was changed and nothing was lost,
      // so a toast here would be noise about an action the user can just repeat.
    }
  }, [chatId]);

  const onUpdate = useCallback(() => {
    void load();
    window.dispatchEvent(new CustomEvent("chat:changed", { detail: { id: chatId } }));
  }, [load, chatId]);

  return (
    // `relative`: the menu's invisible anchor is positioned against it, which is
    // what puts the popover under this button instead of the page's corner.
    <span className="pointer-events-auto relative inline-flex">
      <Hint label={t("menu.options")}>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            if (chat) setMenuOpen(true);
            else {
              wantOpen.current = true;
              void load();
            }
          }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </Hint>
      {chat && (
        <ChatContextMenu
          chat={chat}
          onUpdate={onUpdate}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          showTrigger={false}
          // No row here to turn into a text field — see renameInDialog.
          renameInDialog
          contentProps={{ side: "bottom", align: "end", sideOffset: 8, className: "w-auto" }}
        />
      )}
    </span>
  );
}
