"use client";

import { useEffect } from "react";

import { subscribeEvents } from "@/lib/event-stream";
import { withBrand } from "@/lib/metadata";

/** Keeps the browser tab in step with the conversation's name.
 *
 *  `generateMetadata` on the page is only right at first paint: a new chat is
 *  titled by a background LLM call a moment AFTER the turn finishes (see
 *  `autoTitle` in tasks/runner.ts), and a rename happens without a navigation at
 *  all — so in both cases the server-rendered title is already stale and nothing
 *  would refresh it short of a reload. `chat:title` is the same one-shot event
 *  the sidebar swaps its row on, and the stream is multiplexed, so listening
 *  here costs one more callback on an EventSource that is already open.
 *
 *  Writing `document.title` is only reliable this late: Next STREAMS metadata,
 *  so its own `<title>` commits after hydration and overwrites anything written
 *  from an effect on mount — which is why "what page is this" has to come from
 *  `generateMetadata`, and only a change arriving later belongs here. */
export function ChatTitleSync({ chatId }: { chatId: string }) {
  useEffect(() => {
    return subscribeEvents({
      onMessage: (event) => {
        const d = event as { type?: string; chatId?: string; title?: string };
        if (d.type !== "chat:title" || d.chatId !== chatId || !d.title) return;
        document.title = withBrand(d.title);
      },
    });
  }, [chatId]);

  return null;
}
