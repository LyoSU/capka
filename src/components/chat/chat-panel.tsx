"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { ChatMessage, ThinkingIndicator } from "@/components/chat/message";
import { ChatInput } from "@/components/chat/chat-input";
import { ModelSelector } from "@/components/chat/model-selector";

interface ChatPanelProps {
  chatId: string;
  defaultModel: string;
}

function fetchMessages(chatId: string) {
  return fetch(`/api/chat?chatId=${chatId}`).then((r) => (r.ok ? r.json() : []));
}

export function ChatPanel({ chatId, defaultModel }: ChatPanelProps) {
  const [model, setModel] = useState(defaultModel);
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat", body: { chatId } }),
    [chatId],
  );

  const { messages, setMessages, sendMessage, status, stop, error } = useChat({
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

  useEffect(() => {
    if (error) {
      toast.error(error.message || "Chat error");
    }
  }, [error]);

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
            // Refetch messages and title
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
    try {
      await sendMessage({ text }, { body: { model } });
    } catch (err) {
      console.error("[chat] sendMessage error:", err);
      toast.error("Failed to send message");
    }
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      {isEmpty ? (
        <div className="relative flex flex-1 flex-col items-center justify-center gap-4">
          <div className="inline-flex rounded-full border bg-background/80 px-1 shadow-sm backdrop-blur-sm">
            <ModelSelector value={model} onChange={setModel} />
          </div>
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Start a conversation</p>
          <div className="w-full max-w-xl px-4">
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
          <div className="flex items-center px-4 py-2">
            <div className="inline-flex rounded-full border bg-background/80 px-1 shadow-sm backdrop-blur-sm">
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

          <div className="absolute inset-x-0 bottom-0">
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
