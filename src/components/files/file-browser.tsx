"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  Download,
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  Home,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UploadDialog } from "@/components/files/upload-dialog";
import { CreateDirectoryDialog } from "@/components/files/create-directory-dialog";
import { cn } from "@/lib/utils";
import { formatSize } from "@/lib/files";

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
};

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h",
  "css", "scss", "html", "xml", "json", "yaml", "yml", "toml", "sh", "sql",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);
const TEXT_EXTS = new Set(["md", "txt", "csv", "log", "env", "ini", "cfg"]);

function getFileIcon(name: string, isDirectory: boolean) {
  if (isDirectory) return Folder;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (CODE_EXTS.has(ext)) return FileCode;
  if (IMAGE_EXTS.has(ext)) return FileImage;
  if (TEXT_EXTS.has(ext)) return FileText;
  return File;
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function FileBrowser({ projectId }: { projectId?: string }) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (currentPath) params.set("path", currentPath);
      if (projectId) params.set("projectId", projectId);
      const res = await fetch(`/api/files?${params}`);
      if (res.ok) {
        setEntries(await res.json());
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [currentPath, projectId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const navigate = (path: string) => setCurrentPath(path);

  const handleDelete = async (filePath: string) => {
    setDeleting(true);
    try {
      const res = await fetch("/api/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, projectId }),
      });
      if (res.ok) {
        setDeleteTarget(null);
        fetchFiles();
      }
    } catch {
      // silent
    } finally {
      setDeleting(false);
    }
  };

  const downloadUrl = (filePath: string) => {
    const params = projectId ? `?projectId=${projectId}` : "";
    return `/api/files/${filePath}${params}`;
  };

  // Breadcrumb segments
  const segments = currentPath ? currentPath.split("/") : [];
  const breadcrumbs = segments.map((seg, i) => ({
    label: seg,
    path: segments.slice(0, i + 1).join("/"),
  }));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        {/* Breadcrumbs */}
        <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          <button
            onClick={() => navigate("")}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          {breadcrumbs.map((bc) => (
            <span key={bc.path} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              <button
                onClick={() => navigate(bc.path)}
                className="truncate rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {bc.label}
              </button>
            </span>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <CreateDirectoryDialog
            currentPath={currentPath}
            projectId={projectId}
            onCreated={fetchFiles}
          />
          <UploadDialog
            currentPath={currentPath}
            projectId={projectId}
            onUploaded={fetchFiles}
          />
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Folder className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">No files yet</p>
            <p className="mt-1 text-xs">Upload files or create a folder to get started.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">Size</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">Modified</th>
                <th className="w-24 px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const Icon = getFileIcon(entry.name, entry.isDirectory);
                return (
                  <tr
                    key={entry.path}
                    className="group border-b border-transparent transition-colors hover:bg-muted/50"
                  >
                    <td className="px-4 py-1.5">
                      {entry.isDirectory ? (
                        <button
                          onClick={() => navigate(entry.path)}
                          className="flex items-center gap-2 text-foreground hover:underline"
                        >
                          <Icon className={cn("h-4 w-4 shrink-0", entry.isDirectory && "text-primary/70")} />
                          <span className="truncate">{entry.name}</span>
                        </button>
                      ) : (
                        <a
                          href={downloadUrl(entry.path)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-foreground hover:underline"
                        >
                          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{entry.name}</span>
                        </a>
                      )}
                    </td>
                    <td className="hidden px-4 py-1.5 text-muted-foreground sm:table-cell">
                      {entry.isDirectory ? "-" : formatSize(entry.size)}
                    </td>
                    <td className="hidden px-4 py-1.5 text-muted-foreground md:table-cell">
                      {formatDate(entry.modifiedAt)}
                    </td>
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        {!entry.isDirectory && (
                          <>
                            <a
                              href={downloadUrl(entry.path)}
                              download
                              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </a>
                            {deleteTarget === entry.path ? (
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="destructive"
                                  size="xs"
                                  onClick={() => handleDelete(entry.path)}
                                  disabled={deleting}
                                >
                                  {deleting ? "..." : "Delete"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => setDeleteTarget(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setDeleteTarget(entry.path)}
                                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
