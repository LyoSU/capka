"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { toast } from "sonner";

import { ChatMessage, ThinkingIndicator } from "@/components/chat/message";
import { ChatInput } from "@/components/chat/chat-input";
import { ModelSelector } from "@/components/chat/model-selector";

interface ChatPanelProps {
  chatId: string;
  defaultModel: string;
  projectId?: string;
}

function fetchMessages(chatId: string) {
  return fetch(`/api/chat?chatId=${chatId}`).then((r) => (r.ok ? r.json() : []));
}

export function ChatPanel({ chatId, defaultModel, projectId }: ChatPanelProps) {
  const [model, setModel] = useState(defaultModel);
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { chatId, projectId } }),
    [chatId, projectId],
  );

  const { messages, setMessages, sendMessage, status, stop } = useChat({
    id: chatId,
    transport,
    onError: (err) => {
      console.error("[chat] useChat error:", err);
      toast.error(err.message || "Failed to send message");
    },
  });

  // Load chat history from DB on mount
  useEffect(() => {
    fetchMessages(chatId)
      .then((history) => { if (history.length > 0) setMessages(history); })
      .catch(() => {});
  }, [chatId, setMessages]);

  // SSE: listen for real-time events (e.g. Telegram messages)
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource("/api/events");
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "new_message" && data.chatId === chatId) {
            fetchMessages(chatId)
              .then((msgs) => { if (msgs?.length) setMessages(msgs); })
              .catch(() => {});
          }
        } catch { /* ignore parse errors */ }
      };
      es.onerror = () => {
        es?.close();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 5000);
      };
    };

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [chatId, setMessages]);

  const isLoading = status === "streaming" || status === "submitted";
  const [input, setInput] = useState("");

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    // onError callback handles stream errors via toast — catch only silences
    // unhandled rejections from sendMessage itself (e.g. network failure before stream)
    await sendMessage({ text }, { body: { model } }).catch(() => {});
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      {isEmpty ? (
        <div className="relative flex flex-1 flex-col items-center justify-center px-4">
          <div className="w-full max-w-2xl space-y-8">
            <div className="text-center space-y-3">
              <h1 className="text-4xl font-medium tracking-tight text-foreground/85">
                What can I help with?
              </h1>
              <div className="inline-flex rounded-full border bg-card px-1 shadow-sm">
                <ModelSelector value={model} onChange={setModel} />
              </div>
            </div>
            <ChatInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onStop={stop}
              isLoading={isLoading}
            />
          </div>
        </div>
      ) : (
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center border-b px-4 py-2">
            <div className="inline-flex rounded-full border bg-card px-1 shadow-sm">
              <ModelSelector value={model} onChange={setModel} />
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto pb-24">
            <div className="mx-auto max-w-3xl">
              {messages.map((message, i) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  isStreaming={
                    isLoading &&
                    i === messages.length - 1 &&
                    message.role === "assistant"
                  }
                />
              ))}
              {isLoading && messages.length > 0 && messages[messages.length - 1].role === "user" && (
                <div className="px-4 py-3">
                  <ThinkingIndicator />
                </div>
              )}
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-6">
            <ChatInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onStop={stop}
              isLoading={isLoading}
            />
          </div>
        </div>
      )}
    </div>
  );
}
