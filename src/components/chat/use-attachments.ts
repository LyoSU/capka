"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { formatSize, inferMimeType, type FileRef } from "@/lib/constants";
import type { AttachedFile } from "./chat-input";

/** Max single file size for upload (100MB). */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

export const DRAFT_FILES_PREFIX = "capka:draft-files:";

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
 * What detaching a chip owes the sandbox.
 *
 * - `delete` — this staging area uploaded it and it has landed, so the copy goes.
 * - `park` — it uploaded it but the upload is still in flight, so there is no
 *   name to delete yet; the deletion is owed once the server returns one. Getting
 *   this case wrong is what left a removed file sitting in the workspace, visible
 *   to the file browser and to the model, with no chip left to remove it.
 * - `keep` — it arrived with an existing message, so the transcript (and any turn
 *   that has since worked on the file) still refers to it. Detach, don't delete.
 */
export function detachPlan(entry: Pick<AttachedFile, "status" | "ref" | "owned">): "delete" | "park" | "keep" {
  if (!entry.owned) return "keep";
  if (entry.status === "ready" && entry.ref) return "delete";
  if (entry.status === "uploading") return "park";
  return "keep"; // errored: nothing ever landed
}

/**
 * Files staged for one message, uploaded eagerly to the chat's sandbox.
 *
 * One hook for all three places a message's files are assembled — the composer,
 * the editor on a sent message, and the editor on a message still queued — so
 * upload, retry, removal and the "is anything still uploading" gate have exactly
 * one implementation. They differ only in the two options below.
 *
 * A file uploads the moment it's attached, so sending is instant (no upload
 * wait) and a retry never re-uploads. Each chip tracks its own status
 * (uploading → ready, or error with a retry).
 *
 * `persistKey` mirrors ready refs to localStorage, so a composer draft's
 * attachments survive a reload or a closed tab — restored as "ready" chips
 * backed by the sandbox copy (their bytes are no longer in memory, but the file
 * is). An editor passes none: its staging area lives only as long as it's open.
 *
 * `initial` seeds chips for files the message ALREADY has. Those are marked
 * not-owned, which is what decides whether detaching also deletes the sandbox
 * copy: a file this hook uploaded belongs to a message that was never sent, so
 * dropping it should leave nothing behind, while a file that arrived with an
 * existing message is referenced by the transcript — and by any later turn that
 * worked on it — so detaching must only stop THIS message from carrying it.
 * Deleting files from the workspace is the file browser's job, not an edit's.
 */
export function useAttachments({
  chatId,
  ensureChat,
  persistKey,
  initial,
}: {
  chatId: string;
  /** Creates the chat row if this is the first thing in it. Editors act on a
   *  chat that plainly exists, so they leave it out. */
  ensureChat?: () => Promise<void>;
  persistKey?: string;
  initial?: FileRef[];
}) {
  const t = useTranslations("chat.input");
  const [files, setFiles] = useState<AttachedFile[]>(() =>
    (initial ?? []).map((ref) => ({
      id: genId(),
      status: "ready" as const,
      name: ref.name,
      type: ref.type,
      ref,
      owned: false,
    })),
  );

  // A live mirror of `files`, so callbacks can read the current entry without
  // doing their work inside a `setFiles` updater. React is free to call an
  // updater twice (it does in StrictMode), and an updater that fires a DELETE
  // is a request sent twice for one click.
  const filesRef = useRef(files);
  filesRef.current = files;

  // Chips removed while their upload was still in flight. The upload has no ref
  // to delete yet at that moment, so the id is parked here and the file is
  // deleted when the upload finally hands one over. Without this the chip
  // vanished from the UI while the file quietly finished landing in the
  // workspace — where the file browser, and the model, still saw it.
  const abandoned = useRef<Set<string>>(new Set());

  const deleteFromSandbox = useCallback(
    (name: string) => {
      // Best-effort: a failed delete leaves a file behind, which is untidy but
      // harmless, and is not worth interrupting the user over.
      void fetch(
        `/api/sandbox/files?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ).catch(() => {});
    },
    [chatId],
  );

  const persist = useCallback(
    (list: AttachedFile[]) => {
      if (!persistKey) return;
      try {
        const refs = list.filter((f) => f.status === "ready" && f.ref).map((f) => f.ref!);
        if (refs.length > 0) localStorage.setItem(persistKey, JSON.stringify(refs));
        else localStorage.removeItem(persistKey);
      } catch {}
    },
    [persistKey],
  );

  // Adopt persisted attachments on mount / chat change. Their bytes are gone from
  // memory, but the sandbox copy remains, so they restore as ready chips — owned,
  // because they belong to a draft that has never been sent.
  useEffect(() => {
    if (!persistKey) return;
    setFiles(
      readRefs(persistKey).map((ref) => ({
        id: genId(), status: "ready" as const, name: ref.name, type: ref.type, ref, owned: true,
      })),
    );
  }, [persistKey]);

  const upload = useCallback(
    async (entry: AttachedFile) => {
      const file = entry.file;
      if (!file) return;
      try {
        await ensureChat?.();
        const form = new FormData();
        form.append("chatId", chatId);
        form.append("path", ".");
        form.append("file", file);
        const res = await fetch("/api/sandbox/files/upload", { method: "POST", body: form });
        if (!res.ok) throw new Error("upload failed");
        const data: { name?: string } = await res.json();
        const ref: FileRef = { name: data.name || file.name, type: inferMimeType(file.name, file.type) };
        // Detached mid-flight: the chip is already gone, so the only thing left
        // to do is take the file back out of the workspace.
        if (abandoned.current.has(entry.id)) {
          abandoned.current.delete(entry.id);
          deleteFromSandbox(ref.name);
          return;
        }
        setFiles((prev) => {
          const next = prev.map((f) => (f.id === entry.id ? { ...f, status: "ready" as const, ref } : f));
          persist(next);
          return next;
        });
      } catch {
        abandoned.current.delete(entry.id);
        setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: "error" as const } : f)));
      }
    },
    [chatId, ensureChat, persist, deleteFromSandbox],
  );

  const add = useCallback(
    (incoming: FileList | File[]) => {
      const staged: AttachedFile[] = [];
      const rejected: string[] = [];
      for (const file of Array.from(incoming)) {
        if (file.size > MAX_FILE_SIZE) rejected.push(`${file.name} (${formatSize(file.size)})`);
        else staged.push({ id: genId(), status: "uploading", name: file.name, type: file.type, file, owned: true });
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
      const entry = filesRef.current.find((f) => f.id === id);
      if (!entry?.file) return;
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status: "uploading" as const } : f)));
      void upload({ ...entry, status: "uploading" });
    },
    [upload],
  );

  const remove = useCallback(
    (id: string) => {
      const entry = filesRef.current.find((f) => f.id === id);
      if (!entry) return;
      const next = filesRef.current.filter((f) => f.id !== id);
      setFiles(next);
      persist(next);
      const plan = detachPlan(entry);
      if (plan === "delete") deleteFromSandbox(entry.ref!.name);
      // `upload` settles a parked one as soon as the server names the file.
      else if (plan === "park") abandoned.current.add(id);
    },
    [persist, deleteFromSandbox],
  );

  // Sent: forget the chips (the message owns the files now — do NOT delete them).
  const clear = useCallback(() => {
    setFiles([]);
    abandoned.current.clear();
    if (!persistKey) return;
    try {
      localStorage.removeItem(persistKey);
    } catch {}
  }, [persistKey]);

  // Failed send: put the (still-uploaded) refs back as ready chips, deduped.
  const restore = useCallback(
    (refs: FileRef[]) => {
      if (refs.length === 0) return;
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.ref?.name).filter(Boolean));
        const restored = refs
          .filter((r) => !seen.has(r.name))
          .map((ref) => ({
            id: genId(), status: "ready" as const, name: ref.name, type: ref.type, ref, owned: true,
          }));
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
