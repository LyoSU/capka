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

  const { messages, sendMessage, status, stop } = useChat({
    id: chatId,
    transport,
  });

  const isLoading = status === "streaming" || status === "submitted";
  const [input, setInput] = useState("");

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage({ text });
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
            {isLoading &&
              messages[messages.length - 1]?.role !== "assistant" && (
                <div className="flex gap-3 px-4 py-4">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background">
                    <MessageSquare className="h-4 w-4" />
                  </div>
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <span className="animate-pulse">...</span>
                  </div>
                </div>
              )}
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
