"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatSize, inferMimeType, type FileRef } from "@/lib/constants";
import type { AttachedFile } from "./chat-input";

/** Max single file size for upload (100MB). */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

const PREFIX = "unclaw:draft-files:";

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readRefs(key: string): FileRef[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((r) => r && typeof r.name === "string" && typeof r.type === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Composer attachments with eager upload and per-chat persistence.
 *
 * A file uploads to the chat's sandbox the moment it's attached, so the send is
 * instant (no upload wait) and a retry never re-uploads. Each chip tracks its own
 * status (uploading → ready, or error with a retry). Ready refs are mirrored to
 * localStorage, so attachments survive a reload or a closed tab — restored as
 * "ready" chips backed by the sandbox copy (their bytes are no longer in memory,
 * but the file is). Detaching a chip deletes its sandbox copy; a successful send
 * just forgets the chips (the sent message now owns those files).
 */
export function useComposerAttachments({
  chatId,
  ensureChat,
}: {
  chatId: string;
  ensureChat: () => Promise<void>;
}) {
  const t = useTranslations("chat.input");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const key = PREFIX + chatId;

  // Mirror the ready refs to localStorage — the single place persistence happens.
  const persist = useCallback(
    (list: AttachedFile[]) => {
      try {
        const refs = list.filter((f) => f.status === "ready" && f.ref).map((f) => f.ref!);
        if (refs.length > 0) localStorage.setItem(key, JSON.stringify(refs));
        else localStorage.removeItem(key);
      } catch {}
    },
    [key],
  );

  // Adopt persisted attachments on mount / chat change. Their bytes are gone from
  // memory, but the sandbox copy remains, so they restore as ready chips.
  useEffect(() => {
    setFiles(
      readRefs(key).map((ref) => ({ id: genId(), status: "ready" as const, name: ref.name, type: ref.type, ref })),
    );
  }, [key]);

  // Upload one staged entry, flipping it to ready (with its server ref) or error.
  const upload = useCallback(
    async (entry: AttachedFile) => {
      const file = entry.file;
      if (!file) return;
      try {
        await ensureChat();
        const form = new FormData();
        form.append("chatId", chatId);
        form.append("path", ".");
        form.append("file", file);
        const res = await fetch("/api/sandbox/files/upload", { method: "POST", body: form });
        if (!res.ok) throw new Error("upload failed");
        const data: { name?: string } = await res.json();
        const ref: FileRef = { name: data.name || file.name, type: inferMimeType(file.name, file.type) };
        setFiles((prev) => {
          const next = prev.map((f) => (f.id === entry.id ? { ...f, status: "ready" as const, ref } : f));
          persist(next);
          return next;
        });
      } catch {
        setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: "error" as const } : f)));
      }
    },
    [chatId, ensureChat, persist],
  );

  // Validate (size cap), stage as uploading chips, and kick off the uploads.
  const add = useCallback(
    (incoming: FileList | File[]) => {
      const staged: AttachedFile[] = [];
      const rejected: string[] = [];
      for (const file of Array.from(incoming)) {
        if (file.size > MAX_FILE_SIZE) rejected.push(`${file.name} (${formatSize(file.size)})`);
        else staged.push({ id: genId(), status: "uploading", name: file.name, type: file.type, file });
      }
      if (rejected.length > 0) {
        toast.error(t("tooLarge", { max: formatSize(MAX_FILE_SIZE), files: rejected.join(", ") }));
      }
      if (staged.length === 0) return;
      setFiles((prev) => [...prev, ...staged]);
      for (const entry of staged) void upload(entry);
    },
    [t, upload],
  );

  const retry = useCallback(
    (id: string) => {
      setFiles((prev) => {
        const entry = prev.find((f) => f.id === id);
        if (!entry?.file) return prev;
        void upload({ ...entry, status: "uploading" });
        return prev.map((f) => (f.id === id ? { ...f, status: "uploading" as const } : f));
      });
    },
    [upload],
  );

  const remove = useCallback(
    (id: string) => {
      setFiles((prev) => {
        const entry = prev.find((f) => f.id === id);
        const next = prev.filter((f) => f.id !== id);
        persist(next);
        // Best-effort: drop the sandbox copy so a detached attachment doesn't
        // linger in the workspace. Fire-and-forget — a failed delete is harmless.
        if (entry?.status === "ready" && entry.ref) {
          void fetch(
            `/api/sandbox/files?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(entry.ref.name)}`,
            { method: "DELETE" },
          ).catch(() => {});
        }
        return next;
      });
    },
    [chatId, persist],
  );

  // Sent: forget the chips (the message owns the files now — do NOT delete them).
  const clear = useCallback(() => {
    setFiles([]);
    try {
      localStorage.removeItem(key);
    } catch {}
  }, [key]);

  // Failed send: put the (still-uploaded) refs back as ready chips, deduped.
  const restore = useCallback(
    (refs: FileRef[]) => {
      if (refs.length === 0) return;
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.ref?.name).filter(Boolean));
        const restored = refs
          .filter((r) => !seen.has(r.name))
          .map((ref) => ({ id: genId(), status: "ready" as const, name: ref.name, type: ref.type, ref }));
        const next = [...restored, ...prev];
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const readyRefs = files.filter((f) => f.status === "ready" && f.ref).map((f) => f.ref!);
  const hasUploading = files.some((f) => f.status === "uploading");

  return { files, add, remove, retry, clear, restore, readyRefs, hasUploading };
}
