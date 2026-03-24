"use client";

import { useCallback, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatSize } from "@/lib/constants";

type UploadResult = { name: string; path?: string; error?: string };

export function UploadDialog({
  currentPath,
  projectId,
  onUploaded,
}: {
  currentPath: string;
  projectId?: string;
  onUploaded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    setFiles((prev) => [...prev, ...Array.from(fileList)]);
    setResults([]);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const handleUpload = async () => {
    if (!files.length) return;
    setUploading(true);
    setResults([]);

    const form = new FormData();
    for (const file of files) form.append("file", file);
    form.append("path", currentPath);
    if (projectId) form.append("projectId", projectId);

    try {
      const res = await fetch("/api/files/upload", {
        method: "POST",
        body: form,
      });
      const data: UploadResult[] = await res.json();
      setResults(data);

      if (data.every((r) => !r.error)) {
        setFiles([]);
        setOpen(false);
        onUploaded();
      }
    } catch {
      setResults([{ name: "upload", error: "Upload failed" }]);
    } finally {
      setUploading(false);
    }
  };

  const reset = () => {
    setFiles([]);
    setResults([]);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Upload className="h-3.5 w-3.5" data-icon="inline-start" />
            Upload
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload files</DialogTitle>
          <DialogDescription>
            Drop files here or click to browse. Max 50MB per file.
          </DialogDescription>
        </DialogHeader>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors",
            dragOver
              ? "border-primary/50 bg-primary/5"
              : "border-border hover:border-primary/30",
          )}
        >
          <Upload className="mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {dragOver ? "Drop files here" : "Click or drag files to upload"}
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {files.length > 0 && (
          <div className="space-y-1">
            {files.map((f, i) => {
              const result = results.find((r) => r.name === f.name);
              return (
                <div
                  key={`${f.name}-${i}`}
                  className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5 text-sm"
                >
                  <span className="truncate">{f.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                    {result?.error ? (
                      <span className="text-destructive">{result.error}</span>
                    ) : (
                      formatSize(f.size)
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button
            onClick={handleUpload}
            disabled={!files.length || uploading}
            size="sm"
          >
            {uploading ? "Uploading..." : `Upload ${files.length} file${files.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
