"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight, Download, File, FileCode, FileImage, FileText,
  Folder, FolderOpen, Home, RefreshCw, Upload, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatSize } from "@/lib/constants";

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
};

const CODE_EXTS = new Set(["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "css", "html", "json", "yaml", "yml", "sh", "sql", "md"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

function getIcon(name: string, isDir: boolean) {
  if (isDir) return FolderOpen;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (CODE_EXTS.has(ext)) return FileCode;
  if (IMAGE_EXTS.has(ext)) return FileImage;
  if (["txt", "csv", "log"].includes(ext)) return FileText;
  return File;
}

export function SandboxFiles({
  chatId,
  open,
  onClose,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ chatId, path });
      const res = await fetch(`/api/sandbox/files?${params}`);
      const data = await res.json();
      if (data.error) setError(data.error);
      setEntries(data.entries ?? []);
    } catch {
      setError("Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [chatId, path]);

  useEffect(() => {
    if (open) fetchFiles();
  }, [open, fetchFiles]);

  const navigate = (newPath: string) => setPath(newPath);

  const downloadUrl = (filePath: string) =>
    `/api/sandbox/files/download?chatId=${chatId}&path=${encodeURIComponent(filePath)}`;

  // Breadcrumbs
  const segments = path === "." ? [] : path.split("/");
  const breadcrumbs = segments.map((seg, i) => ({
    label: seg,
    path: segments.slice(0, i + 1).join("/"),
  }));

  // Sort: directories first, then alphabetical
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("chatId", chatId);
        form.append("path", path);
        form.append("file", file);
        const res = await fetch("/api/sandbox/files/upload", { method: "POST", body: form });
        if (!res.ok) {
          const data = await res.json();
          toast.error(`Failed to upload ${file.name}: ${data.error}`);
        }
      }
      fetchFiles();
      toast.success("Files uploaded");
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex h-full w-80 flex-col border-l bg-card shadow-lg md:static md:z-auto md:shadow-none">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Workspace</span>
        <div className="flex items-center gap-1">
          <label title="Upload files">
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
            <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
              <Upload className={`h-3.5 w-3.5 ${uploading ? "animate-pulse" : ""}`} />
            </div>
          </label>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={fetchFiles} title="Refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 border-b px-3 py-1.5 text-xs">
        <button
          onClick={() => setPath(".")}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <Home className="h-3 w-3" />
        </button>
        {breadcrumbs.map((bc) => (
          <span key={bc.path} className="flex items-center gap-1">
            <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/40" />
            <button
              onClick={() => navigate(bc.path)}
              className="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground"
            >
              {bc.label}
            </button>
          </span>
        ))}
      </div>

      {/* File list — drop zone */}
      <div
        className={`flex-1 overflow-y-auto transition-colors ${dragOver ? "bg-primary/5 ring-2 ring-inset ring-primary/20" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {error && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            {error.includes("Session not found") ? (
              <div className="space-y-2">
                <Folder className="mx-auto h-8 w-8 opacity-20" />
                <p>Sandbox not started yet</p>
                <p className="text-muted-foreground/60">Send a message to start the sandbox</p>
              </div>
            ) : (
              <p>{error}</p>
            )}
          </div>
        )}

        {!error && sorted.length === 0 && !loading && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            <Folder className="mx-auto mb-2 h-8 w-8 opacity-20" />
            <p>Empty workspace</p>
          </div>
        )}

        {sorted.map((entry) => {
          const Icon = getIcon(entry.name, entry.isDirectory);
          return (
            <div
              key={entry.path}
              className="group flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors"
            >
              <Icon className={`h-4 w-4 shrink-0 ${entry.isDirectory ? "text-primary/60" : "text-muted-foreground/60"}`} />
              {entry.isDirectory ? (
                <button
                  onClick={() => navigate(entry.path)}
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                >
                  {entry.name}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              )}
              <span className="shrink-0 text-[10px] text-muted-foreground/40 tabular-nums">
                {entry.isDirectory ? "" : formatSize(entry.size)}
              </span>
              {!entry.isDirectory && (
                <a
                  href={downloadUrl(entry.path)}
                  download={entry.name}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 hover:text-foreground group-hover:opacity-100 transition-opacity"
                >
                  <Download className="h-3 w-3" />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
