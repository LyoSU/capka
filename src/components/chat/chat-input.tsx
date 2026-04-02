"use client";

import { useRef, useState, useCallback, type KeyboardEvent, type DragEvent } from "react";
import { ArrowUp, Paperclip, Square, X, File, FileText, FileImage, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/lib/constants";

/** Max single file size for upload (100MB) */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

export type AttachedFile = {
  file: File;
  id: string;
};

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isLoading: boolean;
  files: AttachedFile[];
  onFilesChange: (files: AttachedFile[]) => void;
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return FileImage;
  if (["xlsx", "xls", "csv"].includes(ext)) return FileSpreadsheet;
  if (["pdf", "doc", "docx", "txt", "md"].includes(ext)) return FileText;
  return File;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
  files,
  onFilesChange,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if ((value.trim() || files.length > 0) && !isLoading) {
        onSubmit();
      }
    }
  };

  const addFiles = (newFiles: FileList | File[]) => {
    const valid: AttachedFile[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(newFiles)) {
      if (file.size > MAX_FILE_SIZE) {
        rejected.push(`${file.name} (${formatSize(file.size)})`);
      } else {
        valid.push({ file, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
      }
    }
    if (rejected.length > 0) {
      toast.error(`Too large (max ${formatSize(MAX_FILE_SIZE)}): ${rejected.join(", ")}`);
    }
    if (valid.length > 0) onFilesChange([...files, ...valid]);
  };

  const removeFile = (id: string) => {
    onFilesChange(files.filter((f) => f.id !== id));
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pastedFiles = Array.from(e.clipboardData.files);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      addFiles(pastedFiles);
    }
  };

  const hasContent = value.trim() || files.length > 0;

  return (
    <div className="px-4 md:px-6 pb-6 pt-2">
      <div className="mx-auto max-w-3xl lg:max-w-4xl">
        <div
          className={`overflow-hidden rounded-2xl border bg-card shadow-sm transition-all focus-within:shadow-md ${dragOver ? "ring-2 ring-primary/30 border-primary/30" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {/* Attached files preview */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {files.map((af) => {
                const Icon = fileIcon(af.file.name);
                return (
                  <div
                    key={af.id}
                    className="group flex items-center gap-1.5 rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs"
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    <span className="max-w-32 truncate">{af.file.name}</span>
                    <span className="text-muted-foreground/40">{formatSize(af.file.size)}</span>
                    <button
                      onClick={() => removeFile(af.id)}
                      className="ml-0.5 rounded-full p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mx-4 mt-3 mb-1 max-h-52 overflow-y-auto scrollbar-thin">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                resize();
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={files.length > 0 ? "Add a message about the files..." : "Assign a task or ask anything"}
              rows={1}
              className="w-full resize-none overflow-hidden bg-transparent pr-2 text-[15px] leading-relaxed placeholder:text-muted-foreground/50 focus-visible:outline-none"
            />
          </div>
          <div className="flex items-center justify-between px-3 pb-2.5">
            {/* Attach button */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 sm:h-8 sm:w-8 rounded-xl text-muted-foreground/50 hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                title="Attach files"
                aria-label="Attach files"
              >
                <Paperclip className="h-4.5 w-4.5 sm:h-4 sm:w-4" />
              </Button>
            </div>

            {/* Submit / Stop */}
            {isLoading ? (
              <Button
                size="icon"
                variant="outline"
                className="h-10 w-10 sm:h-8 sm:w-8 shrink-0 rounded-xl"
                onClick={onStop}
                aria-label="Stop generation"
              >
                <Square className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="h-10 w-10 sm:h-8 sm:w-8 shrink-0 rounded-xl"
                disabled={!hasContent}
                onClick={onSubmit}
                aria-label="Send message"
              >
                <ArrowUp className="h-4.5 w-4.5 sm:h-4 sm:w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
