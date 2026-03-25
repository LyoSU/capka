"use client";

import { useRef, useEffect, useState } from "react";
import { toast } from "sonner";

import { FolderOpen } from "lucide-react";
import { ChatMessage, ThinkingIndicator } from "@/components/chat/message";
import { ChatInput } from "@/components/chat/chat-input";
import { ModelSelector } from "@/components/chat/model-selector";
import { SandboxFiles } from "@/components/chat/sandbox-files";
import { Button } from "@/components/ui/button";
import { useBackgroundChat } from "@/hooks/use-background-chat";

interface ChatPanelProps {
  chatId: string;
  defaultModel: string;
  projectId?: string;
}

export function ChatPanel({ chatId, defaultModel, projectId }: ChatPanelProps) {
  const [model, setModel] = useState(defaultModel);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, isLoading, sendMessage, stop } = useBackgroundChat({
    chatId,
    projectId,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const [input, setInput] = useState("");

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    try {
      await sendMessage(text, model);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send message");
    }
  };

  const isEmpty = messages.length === 0;
  const [filesOpen, setFilesOpen] = useState(false);

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col">
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
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="inline-flex rounded-full border bg-card px-1 shadow-sm">
              <ModelSelector value={model} onChange={setModel} />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setFilesOpen(!filesOpen)}
              title="Workspace files"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto pb-24">
            <div className="mx-auto max-w-3xl">
              {messages.map((message, i) => (
                <ChatMessage
                  key={message.id}
                  message={message as never}
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
      <SandboxFiles chatId={chatId} open={filesOpen} onClose={() => setFilesOpen(false)} />
    </div>
  );
}
