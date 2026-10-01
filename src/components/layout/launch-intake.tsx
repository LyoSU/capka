"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { nanoid } from "nanoid";

import { pushIntake } from "@/lib/chat/intake";

type LaunchParams = { files?: readonly { kind: string; getFile?: () => Promise<File> }[] };
type LaunchQueue = { setConsumer: (consumer: (params: LaunchParams) => void) => void };

/** "Open with Capka" for an installed app (manifest `file_handlers`, Chromium
 *  desktop only). The OS opens the manifest's action URL — /chat, i.e. a fresh
 *  chat — and the files come through `launchQueue`, so they are staged in that
 *  chat's composer the same way an attach would stage them. */
export function LaunchIntake() {
  const router = useRouter();
  useEffect(() => {
    const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
    if (!queue) return;
    queue.setConsumer(async ({ files: handles }) => {
      if (!handles?.length) return;
      const files = (await Promise.all(handles.map((h) => (h.kind === "file" ? h.getFile?.() : undefined)))).filter(
        (f): f is File => !!f,
      );
      if (files.length === 0) return;
      const current = /^\/chat\/([^/]+)$/.exec(window.location.pathname)?.[1];
      const chatId = current ?? nanoid();
      pushIntake(chatId, { files });
      if (!current) router.push(`/chat/${chatId}`);
    });
  }, [router]);
  return null;
}
