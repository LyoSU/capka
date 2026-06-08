"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { inferMimeType, type FileRef } from "@/lib/constants";
import type { TaskEvent } from "@/lib/tasks/events";

// ── Types ────────────────────────────────────────────────────

type Part =
  | { type: "text"; text: string }
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<"idle" | "running">("idle");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskInfo, setTaskInfo] = useState<{ startedAt: number; currentTool: string | null }>({ startedAt: 0, currentTool: null });
  const msgRef = useRef(messages);
  msgRef.current = messages;

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
        setError("Failed to load messages");
      });
  }, [chatId]);

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

      es.onopen = () => { retryDelay = 1000; }; // reset backoff on success

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as TaskEvent;

          // Only handle events for this chat
          if ("chatId" in data && data.chatId !== chatId) return;

          switch (data.type) {
            case "task:start": {
              setStatus("running");
              setTaskInfo({ startedAt: Date.now(), currentTool: null });
              setMessages((prev) => [
                ...prev,
                { id: data.messageId, role: "assistant", parts: [] },
              ]);
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
                  state: "partial-call",
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
                const result = data.result as Record<string, unknown> | undefined;
                const isError = result && typeof result === "object" && "error" in result;
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
        es?.close();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
    };

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [chatId, loadHistory]);

  // ── Polling fallback — catches updates if SSE misses them ──
  useEffect(() => {
    if (status !== "running") return;

    const poll = setInterval(() => {
      // Poll task status — if finished, reload messages
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
          toast.error(`Upload failed: ${names || `${failed} file(s)`} — message not sent`);
          return;
        }
      }

      const displayText = text.trim() || (uploadedFiles.length > 0 ? "Process these files" : "");

      // Optimistically add user message (clean text only, no file metadata)
      const userMsg: Message = {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: displayText }],
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
            attachedFiles: uploadedFiles.length > 0 ? uploadedFiles : undefined,
            messages: currentMessages.map((m) => ({
              id: m.id,
              role: m.role,
              parts: m.parts,
            })),
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Request failed" }));
          throw new Error(err.error || "Request failed");
        }

        const { taskId: newTaskId } = await res.json();
        setTaskId(newTaskId);
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        setStatus("idle");
        throw e;
      }
    },
    [chatId, projectId, uploadFiles],
  );

  // ── Stop / Cancel ──────────────────────────────────────────
  const stop = useCallback(async () => {
    if (!taskId) return;
    await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" }).catch(() => {});
    setStatus("idle");
    setTaskId(null);
  }, [taskId]);

  return { messages, status, error, sendMessage, stop, isLoading: status === "running", taskInfo };
}
