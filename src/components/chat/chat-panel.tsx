"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/layout/header";
import { ChatMessage } from "@/components/chat/message";
import { ChatInput } from "@/components/chat/chat-input";
import { ModelSelector } from "@/components/chat/model-selector";

interface ChatPanelProps {
  chatId: string;
  providers: Record<string, string[]>;
  defaultModel: string;
}

export function ChatPanel({ chatId, providers, defaultModel }: ChatPanelProps) {
  const [model, setModel] = useState(defaultModel);
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { chatId, model },
      }),
    [chatId, model],
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
    fetch(`/api/chat?chatId=${chatId}`)
      .then((r) => r.ok ? r.json() : [])
      .then((history) => {
        if (history.length > 0) setMessages(history);
      })
      .catch(() => {});
  }, [chatId, setMessages]);

  useEffect(() => {
    if (error) {
      toast.error(error.message || "Chat error");
    }
  }, [error]);

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
      await sendMessage({ text });
    } catch (err) {
      console.error("[chat] sendMessage error:", err);
      toast.error("Failed to send message");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Header title="Chat">
        <ModelSelector providers={providers} value={model} onChange={setModel} />
      </Header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <MessageSquare className="h-8 w-8" />
            <p className="text-sm">Start a conversation</p>
          </div>
        ) : (
          <div className="divide-y">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
            {/* Streaming indicator handled by message component showing "..." for empty text */}
          </div>
        )}
      </div>

      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onStop={stop}
        isLoading={isLoading}
      />
    </div>
  );
}
