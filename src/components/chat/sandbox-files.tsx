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

const DOC_EXTS = new Set(["docx", "doc", "pdf", "odt", "rtf", "txt", "log"]);
const SHEET_EXTS = new Set(["xlsx", "xls", "csv", "numbers", "tsv"]);
const CODE_EXTS = new Set(["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "css", "html", "json", "yaml", "yml", "sh", "sql", "md"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

function getFileStyle(name: string, isDir: boolean) {
  if (isDir) return { Icon: FolderOpen, color: "text-primary/70", bg: "bg-primary/10" };
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (DOC_EXTS.has(ext))   return { Icon: FileText,  color: "text-blue-400",    bg: "bg-blue-500/10" };
  if (SHEET_EXTS.has(ext)) return { Icon: FileText,  color: "text-emerald-400", bg: "bg-emerald-500/10" };
  if (IMAGE_EXTS.has(ext)) return { Icon: FileImage, color: "text-violet-400",  bg: "bg-violet-500/10" };
  if (CODE_EXTS.has(ext))  return { Icon: FileCode,  color: "text-amber-400",   bg: "bg-amber-500/10" };
  return { Icon: File, color: "text-muted-foreground/60", bg: "bg-muted/50" };
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

  // Filter dotfiles (internal archives, .git, etc.), sort: directories first then alphabetical
  const sorted = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => {
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

  const fileCount = sorted.filter((e) => !e.isDirectory).length;
  const dirCount = sorted.filter((e) => e.isDirectory).length;

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex h-full w-80 flex-col border-l bg-card shadow-lg md:static md:z-auto md:shadow-none">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Workspace</h3>
          {!error && sorted.length > 0 && (
            <p className="text-[11px] text-muted-foreground/50">
              {dirCount > 0 && `${dirCount} folder${dirCount > 1 ? "s" : ""}`}
              {dirCount > 0 && fileCount > 0 && ", "}
              {fileCount > 0 && `${fileCount} file${fileCount > 1 ? "s" : ""}`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <label title="Upload files">
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
            <div className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground">
              <Upload className={`h-3.5 w-3.5 ${uploading ? "animate-pulse" : ""}`} />
            </div>
          </label>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground/50 hover:text-foreground" onClick={fetchFiles} title="Refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground/50 hover:text-foreground" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Breadcrumbs */}
      {breadcrumbs.length > 0 && (
        <div className="flex items-center gap-0.5 border-b border-border/40 px-4 py-2 text-xs">
          <button
            onClick={() => setPath(".")}
            className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
          >
            <Home className="h-3 w-3" />
          </button>
          {breadcrumbs.map((bc) => (
            <span key={bc.path} className="flex items-center gap-0.5">
              <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/25" />
              <button
                onClick={() => navigate(bc.path)}
                className="rounded-md px-1.5 py-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              >
                {bc.label}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* File list — drop zone */}
      <div
        className={`flex-1 overflow-y-auto transition-all ${
          dragOver
            ? "bg-primary/5 ring-2 ring-inset ring-primary/20 ring-offset-0"
            : ""
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {error && (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            {error.includes("Session not found") ? (
              <>
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50">
                  <Folder className="h-6 w-6 text-muted-foreground/30" />
                </div>
                <p className="text-sm font-medium text-muted-foreground/70">Sandbox not started</p>
                <p className="mt-1 text-xs text-muted-foreground/40">Send a message to create the workspace</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground/60">{error}</p>
            )}
          </div>
        )}

        {!error && sorted.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-border/50">
              <Upload className="h-5 w-5 text-muted-foreground/25" />
            </div>
            <p className="text-sm font-medium text-muted-foreground/60">No files yet</p>
            <p className="mt-1 text-xs text-muted-foreground/35">Drop files here or use the upload button</p>
          </div>
        )}

        {sorted.length > 0 && (
          <div className="py-1">
            {sorted.map((entry) => {
              const { Icon, color, bg } = getFileStyle(entry.name, entry.isDirectory);
              return (
                <div
                  key={entry.path}
                  className="group flex items-center gap-3 px-3 py-1.5 transition-colors hover:bg-accent/50"
                >
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                    <Icon className={`h-4 w-4 ${color}`} />
                  </div>
                  {entry.isDirectory ? (
                    <button
                      onClick={() => navigate(entry.path)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm font-medium">{entry.name}</p>
                    </button>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground/90">{entry.name}</p>
                      <p className="text-[10px] text-muted-foreground/35 tabular-nums">{formatSize(entry.size)}</p>
                    </div>
                  )}
                  {!entry.isDirectory && (
                    <a
                      href={downloadUrl(entry.path)}
                      download={entry.name}
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground/25 opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {entry.isDirectory && (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/20 opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
