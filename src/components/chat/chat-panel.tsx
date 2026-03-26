"use client";

import { useRef, useEffect, useState } from "react";
import { toast } from "sonner";

import { FolderOpen } from "lucide-react";
import { ChatMessage } from "@/components/chat/message";
import { TaskStatus } from "@/components/chat/task-status";
import { ChatInput, type AttachedFile } from "@/components/chat/chat-input";
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

  const { messages, isLoading, sendMessage, stop, taskInfo } = useBackgroundChat({
    chatId,
    projectId,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const [input, setInput] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);

  const handleSubmit = async () => {
    const text = input.trim();
    const attachedFiles = files.map((af) => af.file);
    if (!text && attachedFiles.length === 0) return;

    // Save state for rollback on error
    const savedInput = input;
    const savedFiles = files;
    setInput("");
    setFiles([]);
    try {
      await sendMessage(text, model, attachedFiles.length > 0 ? attachedFiles : undefined);
    } catch (e) {
      // Restore input so user doesn't lose their text
      setInput(savedInput);
      setFiles(savedFiles);
      toast.error(e instanceof Error ? e.message : "Failed to send message");
    }
  };

  const isEmpty = messages.length === 0;
  const [filesOpen, setFilesOpen] = useState(false);

  const inputEl = (
    <ChatInput
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      onStop={stop}
      isLoading={isLoading}
      files={files}
      onFilesChange={setFiles}
    />
  );

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col">
      {isEmpty ? (
        <div className="relative flex flex-1 flex-col items-center justify-center px-6">
          <div className="w-full max-w-3xl space-y-10">
            <div className="text-center space-y-3">
              <h1 className="text-2xl md:text-4xl font-medium tracking-tight text-foreground/85">
                What can I help with?
              </h1>
              <div className="inline-flex rounded-full border bg-card px-1 shadow-sm">
                <ModelSelector value={model} onChange={setModel} />
              </div>
            </div>
            {inputEl}
          </div>
        </div>
      ) : (
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between px-6 py-3">
            <div className="inline-flex rounded-full border bg-card px-1 shadow-sm">
              <ModelSelector value={model} onChange={setModel} />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setFilesOpen(!filesOpen)}
              title="Workspace files"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto pb-40">
            <div className="mx-auto max-w-3xl lg:max-w-4xl px-2 md:px-4">
              {messages.map((message, i) => (
                <ChatMessage
                  key={message.id}
                  message={message as never}
                  chatId={chatId}
                  isStreaming={
                    isLoading &&
                    i === messages.length - 1 &&
                    message.role === "assistant"
                  }
                />
              ))}
              {isLoading && (
                <TaskStatus
                  startedAt={taskInfo.startedAt || Date.now()}
                  currentTool={taskInfo.currentTool}
                  toolCount={taskInfo.toolCount}
                />
              )}
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-6">
            {inputEl}
          </div>
        </div>
      )}
      </div>
      <SandboxFiles chatId={chatId} open={filesOpen} onClose={() => setFilesOpen(false)} />
    </div>
  );
}
