"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";

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

type TaskEvent =
  | { type: "task:start"; taskId: string; chatId: string; messageId: string }
  | { type: "task:text-delta"; taskId: string; chatId: string; messageId: string; delta: string }
  | { type: "task:tool-call"; taskId: string; chatId: string; messageId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "task:tool-result"; taskId: string; chatId: string; messageId: string; toolCallId: string; result: unknown }
  | { type: "task:finish"; taskId: string; chatId: string; messageId: string; status: string; error?: string }
  | { type: "new_message"; chatId: string };

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
  const msgRef = useRef(messages);
  msgRef.current = messages;

  // ── Load history from DB ───────────────────────────────────
  const loadHistory = useCallback(() => {
    fetch(`/api/chat?chatId=${chatId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((history: Message[]) => {
        if (history.length > 0) setMessages(history);
        // Check if the last assistant message is still running
        const last = history[history.length - 1];
        const meta = last?.metadata as { taskStatus?: string } | undefined;
        if (meta?.taskStatus === "running") {
          setStatus("running");
        }
      })
      .catch(() => {});
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
  const sseAlive = useRef(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource("/api/events");

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as TaskEvent;
          sseAlive.current = true;

          // Only handle events for this chat
          if ("chatId" in data && data.chatId !== chatId) return;

          switch (data.type) {
            case "task:start": {
              setStatus("running");
              // Add empty assistant message
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
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === data.messageId);
                if (idx === -1) return prev;
                const msgs = [...prev];
                const msg = msgs[idx];
                const parts = msg.parts.map((p) =>
                  p.type === "dynamic-tool" && p.toolCallId === data.toolCallId
                    ? { ...p, state: "output-available", output: data.result }
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
              // Reload from DB to get clean final state
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
        sseAlive.current = false;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 5000);
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

  // ── Send message ───────────────────────────────────────────
  const sendMessage = useCallback(
    async (text: string, model: string) => {
      if (!text.trim()) return;

      // Optimistically add user message
      const userMsg: Message = {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text }],
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
            userMessage: text,
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
        // task:start SSE event will add the assistant message
      } catch (e) {
        // Rollback optimistic user message
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        setStatus("idle");
        throw e;
      }
    },
    [chatId, projectId],
  );

  // ── Stop / Cancel ──────────────────────────────────────────
  const stop = useCallback(async () => {
    if (!taskId) return;
    await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" }).catch(() => {});
    setStatus("idle");
    setTaskId(null);
  }, [taskId]);

  return { messages, status, sendMessage, stop, isLoading: status === "running" };
}
