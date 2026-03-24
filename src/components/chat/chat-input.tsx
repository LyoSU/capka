"use client";

import { useRef, useCallback, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isLoading: boolean;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !isLoading) {
        onSubmit();
      }
    }
  };

  return (
    <div className="px-4 pb-5 pt-2">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border bg-card shadow-sm transition-shadow focus-within:shadow-md">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              resize();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Assign a task or ask anything"
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-4 pb-2 text-[15px] leading-relaxed placeholder:text-muted-foreground/50 focus-visible:outline-none"
            style={{ maxHeight: 200 }}
          />
          <div className="flex items-center justify-end px-3 pb-2.5">
            {isLoading ? (
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 shrink-0 rounded-xl"
                onClick={onStop}
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="h-8 w-8 shrink-0 rounded-xl"
                disabled={!value.trim()}
                onClick={onSubmit}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
