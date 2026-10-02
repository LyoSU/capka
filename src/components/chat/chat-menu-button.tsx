"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { subscribeEvents } from "@/lib/event-stream";
import { ChatContextMenu, type ChatItem } from "./chat-context-menu";

/**
 * The chat header's two ends: the conversation's name at the left — itself the way
 * into the chat's menu, like a document title — and Share at the right. `start`
 * and `end` are the panel's own pieces (the sidebar handle, the project badge, the
 * files button), slotted in so the header reads as one row in one order.
 *
 * Every menu action already exists on the sidebar's row menu, and this is the
 * same component: the panel simply has no row to borrow the record from, so it
 * fetches one. Lazily, on the first open — the overwhelming majority of chats are
 * read and never administered, and a request per chat load would buy nothing.
 * The NAME needs no fetch: the page renders it, and `chat:title` (the event the
 * sidebar swaps its row on) keeps it live when the generated title lands.
 *
 * An edit here changes the row the sidebar is showing, so it says so on the
 * window and the list re-reads. A CustomEvent rather than a shared store because
 * the two components have no common owner short of the dashboard layout.
 */
export function ChatMenuButton({
  chatId,
  initialTitle,
  readOnly,
  start,
  end,
}: {
  chatId: string;
  initialTitle?: string | null;
  /** A shared, read-only view: the name is shown, none of the actions are the
   *  reader's to take. */
  readOnly?: boolean;
  start?: ReactNode;
  end?: ReactNode;
}) {
  const t = useTranslations("chat");
  const [chat, setChat] = useState<ChatItem | null>(null);
  const [title, setTitle] = useState(initialTitle ?? null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const titleRef = useRef<HTMLButtonElement>(null);
  // Set while a first fetch is in flight, so the click that started it still ends
  // with its surface open rather than silently doing nothing.
  const want = useRef<"menu" | "share" | null>(null);

  useEffect(
    () =>
      subscribeEvents({
        onMessage: (event) => {
          const d = event as { type?: string; chatId?: string; title?: string };
          if (d.type === "chat:title" && d.chatId === chatId && d.title) setTitle(d.title);
        },
      }),
    [chatId],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (!res.ok) return;
      const row = (await res.json()) as ChatItem;
      setChat(row);
      setTitle(row.title);
      if (want.current === "menu") setMenuOpen(true);
      if (want.current === "share") setShareOpen(true);
      want.current = null;
    } catch {
      // The button simply doesn't open. Nothing was changed and nothing was lost,
      // so a toast here would be noise about an action the user can just repeat.
    }
  }, [chatId]);

  const show = (what: "menu" | "share") => {
    if (!chat) {
      want.current = what;
      void load();
    } else if (what === "menu") setMenuOpen(true);
    else setShareOpen(true);
  };

  const onUpdate = useCallback(() => {
    void load();
    window.dispatchEvent(new CustomEvent("chat:changed", { detail: { id: chatId } }));
  }, [load, chatId]);

  const name = title || t("untitled");

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        {start}
        {readOnly ? (
          <span className="min-w-0 truncate px-2 text-sm font-medium">{name}</span>
        ) : (
          <button
            ref={titleRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${name} — ${t("menu.options")}`}
            onClick={() => show("menu")}
            className="pointer-events-auto flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-foreground hover:bg-hover"
          >
            <span className="truncate">{name}</span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {end}
        {!readOnly && (
          <>
            <Hint label={t("menu.share")}>
              <Button
                variant="ghost"
                size="icon"
                className="pointer-events-auto hidden h-8 w-8 shrink-0 sm:inline-flex"
                aria-label={t("menu.share")}
                onClick={() => show("share")}
              >
                <Share2 className="h-4 w-4" />
              </Button>
            </Hint>
          </>
        )}
      </div>
      {chat && (
        <ChatContextMenu
          chat={chat}
          onUpdate={onUpdate}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          shareOpen={shareOpen}
          onShareOpenChange={setShareOpen}
          showTrigger={false}
          contentProps={{
            anchor: titleRef,
            side: "bottom",
            align: "start",
            sideOffset: 8,
            className: "w-auto",
          }}
        />
      )}
    </>
  );
}
