"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { inferMimeType, type FileRef } from "@/lib/constants";
import type { TaskEvent } from "@/lib/tasks/events";

// ── Types ────────────────────────────────────────────────────

type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "dynamic-tool"; toolCallId: string; toolName: string; state: string; input?: unknown; output?: unknown };

type Message = {
  id: string;
  role: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
};

// ── Hook ─────────────────────────────────────────────────────

export function useBackgroundChat({
  chatId,
  projectId,
}: {
  chatId: string;
  projectId?: string;
}) {
  const t = useTranslations("chat.hook");
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<"idle" | "running">("idle");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskInfo, setTaskInfo] = useState<{ startedAt: number; currentTool: string | null }>({ startedAt: 0, currentTool: null });
  const msgRef = useRef(messages);
  msgRef.current = messages;
  // Whether the SSE stream is currently connected — drives how hard the polling
  // fallback works (aggressive only when SSE is down).
  const sseHealthyRef = useRef(false);

  const [error, setError] = useState<string | null>(null);

  // ── Load history from DB ───────────────────────────────────
  const loadHistory = useCallback(() => {
    fetch(`/api/chat?chatId=${chatId}`)
      .then((r) => {
        if (r.status === 404) return []; // new chat — no history yet
        if (!r.ok) throw new Error(`Failed to load chat (${r.status})`);
        return r.json();
      })
      .then((history: Message[]) => {
        if (history.length > 0) setMessages(history);
        setError(null);
        const last = history[history.length - 1];
        const meta = last?.metadata as { taskStatus?: string } | undefined;
        if (meta?.taskStatus === "running") setStatus("running");
      })
      .catch((e) => {
        console.error("[chat] loadHistory failed:", e);
        setError(t("loadFailed"));
      });
  }, [chatId, t]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ── Check for running task on mount (reconnection) ─────────
  useEffect(() => {
    fetch(`/api/tasks?chatId=${chatId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((task) => {
        if (task?.status === "running") {
          setTaskId(task.id);
          setStatus("running");
        }
      })
      .catch(() => {});
  }, [chatId]);

  // ── SSE listener ───────────────────────────────────────────
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000; // exponential backoff: 1s, 2s, 4s, 8s, max 30s

    const connect = () => {
      es = new EventSource("/api/events");

      es.onopen = () => { retryDelay = 1000; sseHealthyRef.current = true; }; // reset backoff on success

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as TaskEvent;

          // Only handle events for this chat
          if ("chatId" in data && data.chatId !== chatId) return;

          switch (data.type) {
            case "task:start": {
              setStatus("running");
              setTaskInfo({ startedAt: Date.now(), currentTool: null });
              // Idempotent: if history already loaded this assistant row
              // (reconnect / cross-channel), don't append a duplicate.
              setMessages((prev) =>
                prev.some((m) => m.id === data.messageId)
                  ? prev
                  : [...prev, { id: data.messageId, role: "assistant", parts: [] }],
              );
              break;
            }

            case "task:text-delta": {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const parts = [...msg.parts];
                const lastPart = parts[parts.length - 1];
                if (lastPart?.type === "text") {
                  parts[parts.length - 1] = { type: "text", text: lastPart.text + data.delta };
                } else {
                  parts.push({ type: "text", text: data.delta });
                }
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:reasoning-delta": {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const parts = [...msg.parts];
                const lastPart = parts[parts.length - 1];
                if (lastPart?.type === "reasoning") {
                  parts[parts.length - 1] = { type: "reasoning", text: lastPart.text + data.delta };
                } else {
                  parts.push({ type: "reasoning", text: data.delta });
                }
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:tool-call": {
              setTaskInfo((prev) => ({ ...prev, currentTool: data.toolName }));
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const parts = [...msg.parts];
                parts.push({
                  type: "dynamic-tool",
                  toolCallId: data.toolCallId,
                  toolName: data.toolName,
                  // Valid AI SDK 6 state — input is here, output pending.
                  state: "input-available",
                  input: data.args,
                });
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:tool-result": {
              setTaskInfo((prev) => ({ ...prev, currentTool: null }));
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                // Trust the server's explicit failure flag — a successful tool can
                // legitimately carry an `error: null` field, which must not read
                // as a failure (otherwise it flashes red mid-stream).
                const isError = data.isError === true;
                const parts = msg.parts.map((p) =>
                  p.type === "dynamic-tool" && p.toolCallId === data.toolCallId
                    ? { ...p, state: isError ? "output-error" : "output-available", output: data.result }
                    : p,
                );
                msgs[idx] = { ...msg, parts };
                return msgs;
              });
              break;
            }

            case "task:finish": {
              setStatus("idle");
              setTaskId(null);
              setTaskInfo({ startedAt: 0, currentTool: null });
              if (data.error) setError(data.error);
              loadHistory();
              break;
            }

            case "new_message": {
              // External message (e.g. Telegram) — reload
              loadHistory();
              break;
            }
          }
        } catch { /* ignore parse errors */ }
      };

      es.onerror = () => {
        sseHealthyRef.current = false;
        es?.close();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
    };

    connect();
    return () => {
      sseHealthyRef.current = false;
      clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [chatId, loadHistory]);

  // ── Polling fallback — only really needed when SSE is down ──
  useEffect(() => {
    if (status !== "running") return;

    let ticks = 0;
    const poll = setInterval(() => {
      ticks += 1;
      // When SSE is healthy it already delivers task:finish — running a full
      // poll alongside it every 3s is wasted load. Poll aggressively only while
      // SSE is down; otherwise keep a light insurance check (~every 21s).
      if (sseHealthyRef.current && ticks % 7 !== 0) return;

      fetch(`/api/tasks?chatId=${chatId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((task) => {
          if (!task || task.status !== "running") {
            setStatus("idle");
            setTaskId(null);
            loadHistory();
            clearInterval(poll);
          }
        })
        .catch(() => {});
    }, 3000);

    return () => clearInterval(poll);
  }, [status, chatId, loadHistory]);

  // ── Ensure chat row exists in DB (needed before file upload) ──
  const ensureChatRef = useRef(false);
  const ensureChat = useCallback(async () => {
    if (ensureChatRef.current) return;
    ensureChatRef.current = true;
    await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: chatId, projectId }),
    }).catch(() => {}); // ignore conflict (chat already exists)
  }, [chatId, projectId]);

  // ── Upload files to sandbox workspace (parallel) ─────────────
  const uploadFiles = useCallback(
    async (files: File[]): Promise<FileRef[]> => {
      await ensureChat();
      const results = await Promise.allSettled(
        files.map(async (file) => {
          const form = new FormData();
          form.append("chatId", chatId);
          form.append("path", ".");
          form.append("file", file);
          const res = await fetch("/api/sandbox/files/upload", { method: "POST", body: form });
          if (!res.ok) throw new Error("upload failed");
          const data: { name?: string } = await res.json();
          return { name: data.name || file.name, type: inferMimeType(file.name, file.type) };
        }),
      );
      return results
        .filter((r): r is PromiseFulfilledResult<FileRef> => r.status === "fulfilled")
        .map((r) => r.value);
    },
    [chatId, ensureChat],
  );

  // ── Send message ───────────────────────────────────────────
  const sendMessage = useCallback(
    async (text: string, model: string, files?: File[]) => {
      if (!text.trim() && (!files || files.length === 0)) return;

      // Upload files first — AI needs them in workspace before processing
      let uploadedFiles: FileRef[] = [];
      if (files && files.length > 0) {
        uploadedFiles = await uploadFiles(files);
        const failed = files.length - uploadedFiles.length;
        if (failed > 0) {
          const uploadedNames = new Set(uploadedFiles.map((f) => f.name));
          const names = files.filter((f) => !uploadedNames.has(f.name)).map((f) => f.name).join(", ");
          toast.error(t("uploadFailed", { files: names || `${failed}` }));
          return;
        }
      }

      const displayText = text.trim() || (uploadedFiles.length > 0 ? t("processFiles") : "");

      // Optimistically add the user message. Carry the attachment refs in
      // metadata so the bubble shows thumbnails immediately — before history
      // reloads — matching what the server persists.
      const userMsg: Message = {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: displayText }],
        metadata: uploadedFiles.length > 0 ? { attachedFiles: uploadedFiles } : undefined,
      };
      const currentMessages = [...msgRef.current, userMsg];
      setMessages(currentMessages);
      setStatus("running");

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            projectId,
            model,
            userMessage: displayText,
            userMessageId: userMsg.id,
            attachedFiles: uploadedFiles.length > 0 ? uploadedFiles : undefined,
            messages: currentMessages.map((m) => ({
              id: m.id,
              role: m.role,
              parts: m.parts,
            })),
          }),
        });

        if (!res.ok) {
          if (res.status === 429) throw new Error(t("rateLimited"));
          const err = await res.json().catch(() => ({ error: t("requestFailed") }));
          throw new Error(err.error || t("requestFailed"));
        }

        const { taskId: newTaskId } = await res.json();
        setTaskId(newTaskId);
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        setStatus("idle");
        throw e;
      }
    },
    [chatId, projectId, uploadFiles, t],
  );

  // ── Re-run the tail (regenerate / edit) ────────────────────
  // Both share a shape: truncate the DB from a point, set the optimistic
  // history, then POST to /api/chat. Omitting `model` lets the server reuse the
  // chat's persisted model. An empty userMessage means "don't insert a new user
  // row" (regenerate); a non-empty one re-inserts the edited message (edit).
  const rerun = useCallback(
    async (history: Message[], userMessage: string, userMessageId?: string) => {
      // Non-destructive: the server inserts a sibling branch keyed off the
      // history we send, so the previous version stays reachable via ‹ i/N ›.
      setMessages(history);
      setStatus("running");
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            projectId,
            userMessage,
            userMessageId,
            messages: history.map((m) => ({ id: m.id, role: m.role, parts: m.parts })),
          }),
        });
        if (!res.ok) {
          if (res.status === 429) throw new Error(t("rateLimited"));
          const err = await res.json().catch(() => ({ error: t("requestFailed") }));
          throw new Error(err.error || t("requestFailed"));
        }
        const { taskId: newTaskId } = await res.json();
        setTaskId(newTaskId);
      } catch (e) {
        setStatus("idle");
        loadHistory(); // the DB and UI may now disagree — resync from source
        throw e;
      }
    },
    [chatId, projectId, t, loadHistory],
  );

  // Regenerate: drop the latest assistant reply and re-run the same prompt.
  const regenerate = useCallback(async () => {
    const msgs = msgRef.current;
    let lastAssistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx === -1) return;
    const history = msgs.slice(0, lastAssistantIdx);
    if (!history.some((m) => m.role === "user")) return;
    await rerun(history, "");
  }, [rerun]);

  // Edit: replace a user message's text and re-run from there.
  const editMessage = useCallback(async (messageId: string, newText: string) => {
    const text = newText.trim();
    if (!text) return;
    const msgs = msgRef.current;
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const history = msgs.slice(0, idx);
    const edited: Message = { id: nanoid(), role: "user", parts: [{ type: "text", text }] };
    await rerun([...history, edited], text, edited.id);
  }, [rerun]);

  // ── Switch branch (‹ i/N › version arrows) ─────────────────
  // Point the chat at another sibling's branch, then resync from the server,
  // which returns that branch as the visible conversation.
  const switchBranch = useCallback(async (messageId: string, direction: "prev" | "next") => {
    await fetch("/api/chat", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, messageId, direction }),
    }).catch(() => {});
    loadHistory();
  }, [chatId, loadHistory]);

  // ── Fork from a message into a new independent chat ─────────
  const forkChat = useCallback(async (fromMessageId: string): Promise<string | null> => {
    const res = await fetch("/api/chats/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, fromMessageId }),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const { id } = (await res.json()) as { id: string };
    return id;
  }, [chatId]);

  // ── Stop / Cancel ──────────────────────────────────────────
  const stop = useCallback(async () => {
    if (!taskId) return;
    await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" }).catch(() => {});
    setStatus("idle");
    setTaskId(null);
  }, [taskId]);

  return { messages, status, error, sendMessage, regenerate, editMessage, switchBranch, forkChat, stop, reload: loadHistory, isLoading: status === "running", taskInfo };
}
