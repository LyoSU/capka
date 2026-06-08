"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown, Download, Folder, Loader2, Upload, X, Check, AlertCircle, ChevronLeft,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { formatSize } from "@/lib/constants";
import { fileKind } from "@/lib/file-kinds";
import { describeStep } from "./steps";
import type { AttachedFile } from "./chat-input";

type FileEntry = { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: string | null };

/** A progress step derived from an assistant message's tool parts. */
export type ProgressStep = { toolName: string; state: string; input?: unknown };

function Section({ title, count, defaultOpen, action, children }: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-b border-border/40">
      <div className="flex items-center gap-1 px-3 py-2.5">
        <CollapsibleTrigger className="group flex flex-1 items-center gap-1.5 text-left [&[data-state=open]>.chevron]:rotate-0 [&[data-state=closed]>.chevron]:-rotate-90">
          <ChevronDown className="chevron h-3.5 w-3.5 text-muted-foreground/40 transition-transform" />
          <span className="text-[11px] font-semibold text-muted-foreground">{title}</span>
          {count !== undefined && count > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
          )}
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent>
        <div className="pb-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Progress ───────────────────────────────────────────────────────────────

function ProgressSection({ steps, running }: { steps: ProgressStep[]; running: boolean }) {
  if (steps.length === 0) {
    return (
      <Section title="Progress" defaultOpen>
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {running ? "Starting…" : "Steps will appear here as the assistant works."}
        </p>
      </Section>
    );
  }
  return (
    <Section title="Progress" defaultOpen>
      <div className="space-y-0.5 px-3">
        {steps.map((s, i) => {
          const { label, activeLabel, Icon } = describeStep(s.toolName, s.input);
          const done = s.state === "output-available";
          const failed = s.state === "output-error";
          return (
            <div key={i} className="flex items-center gap-2 py-1 text-xs">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {done ? <Check className="h-3.5 w-3.5 text-success" />
                  : failed ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                  : <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />}
              </span>
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
              <span className={`truncate ${failed ? "text-destructive/80" : done ? "text-foreground/80" : "text-muted-foreground"}`}>
                {done || failed ? label : activeLabel}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ── Context (pending attachments) ────────────────────────────────────────────

function ContextSection({ attachments }: { attachments: AttachedFile[] }) {
  const urls = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of attachments) {
      if (a.file.type.startsWith("image/")) m.set(a.id, URL.createObjectURL(a.file));
    }
    return m;
  }, [attachments]);

  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  if (attachments.length === 0) {
    return (
      <Section title="Context">
        <p className="px-4 py-3 text-xs text-muted-foreground">Files you attach to your message appear here.</p>
      </Section>
    );
  }
  return (
    <Section title="Context" count={attachments.length} defaultOpen>
      <div className="space-y-1 px-3">
        {attachments.map((a) => {
          const isImage = a.file.type.startsWith("image/");
          const url = urls.get(a.id);
          const { Icon, color, bg } = fileKind(a.file.name);
          return (
            <div key={a.id} className="flex items-center gap-3 rounded-lg px-1 py-1">
              {isImage && url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={a.file.name} className="h-9 w-9 shrink-0 rounded-lg object-cover" />
              ) : (
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                  <Icon className={`h-4 w-4 ${color}`} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground/90">{a.file.name}</p>
                <p className="text-[10px] text-muted-foreground">
                  {isImage ? "Image" : "File"} · {formatSize(a.file.size)} · you added
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ── Files (workspace) ────────────────────────────────────────────────────────

function FilesSection({ chatId }: { chatId: string }) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sandbox/files?${new URLSearchParams({ chatId, path })}`);
      const data = await res.json();
      if (data.error) setError(data.error);
      setEntries(data.entries ?? []);
    } catch {
      setError("Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [chatId, path]);

  useEffect(() => { fetchFiles(); }, [fetchFiles]);

  const sorted = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => (a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name)));
  const files = sorted.filter((e) => !e.isDirectory);

  const downloadUrl = (p: string) => `/api/sandbox/files/download?chatId=${chatId}&path=${encodeURIComponent(p)}`;
  const downloadAll = () => {
    const params = new URLSearchParams({ chatId });
    files.forEach((f) => params.append("paths", f.path));
    const a = document.createElement("a");
    a.href = `/api/sandbox/files/download-all?${params}`;
    a.download = "workspace-files.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const upload = async (fileList: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const form = new FormData();
        form.append("chatId", chatId);
        form.append("path", path);
        form.append("file", file);
        const res = await fetch("/api/sandbox/files/upload", { method: "POST", body: form });
        if (!res.ok) toast.error(`Failed to upload ${file.name}`);
      }
      fetchFiles();
    } finally {
      setUploading(false);
    }
  };

  const action = (
    <div className="flex items-center gap-0.5">
      <label title="Upload files" aria-label="Upload files">
        <input type="file" multiple className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
        <div className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Upload className={`h-3.5 w-3.5 ${uploading ? "animate-pulse" : ""}`} />
        </div>
      </label>
      {files.length > 1 && (
        <button onClick={downloadAll} title="Download all" className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Download className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <Section title="Files" count={files.length} defaultOpen action={action}>
      {path !== "." && (
        <button
          onClick={() => setPath(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".")}
          className="mx-3 mb-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Back
        </button>
      )}

      {loading && sorted.length === 0 && (
        <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" /></div>
      )}

      {error && (
        <div className="px-4 py-4 text-center">
          {error.includes("Session not found") || error.includes("not found") ? (
            <p className="text-xs text-muted-foreground">Send a message to create the workspace.</p>
          ) : (
            <p className="text-xs text-muted-foreground">{error}</p>
          )}
        </div>
      )}

      {!error && sorted.length === 0 && !loading && (
        <p className="px-4 py-3 text-xs text-muted-foreground">No files yet.</p>
      )}

      <div className="space-y-0.5 px-3">
        {sorted.map((entry) => {
          const { Icon, color, bg } = fileKind(entry.name, entry.isDirectory);
          return (
            <div key={entry.path} className="group flex items-center gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-accent/40">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
              {entry.isDirectory ? (
                <button onClick={() => setPath(entry.path)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium">{entry.name}</p>
                </button>
              ) : (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground/90">{entry.name}</p>
                  <p className="text-[10px] tabular-nums text-muted-foreground">{formatSize(entry.size)}</p>
                </div>
              )}
              {!entry.isDirectory && (
                <a href={downloadUrl(entry.path)} download={entry.name}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-all hover:bg-accent hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100">
                  <Download className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function WorkspacePanel({
  chatId,
  open,
  onClose,
  steps,
  running,
  attachments,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
  steps: ProgressStep[];
  running: boolean;
  attachments: AttachedFile[];
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-y-0 right-0 z-40 flex h-full w-80 flex-col border-l bg-card shadow-lg md:static md:z-auto md:shadow-none">
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Folder className="h-4 w-4 text-muted-foreground" /> Working
        </h3>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close panel">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <ProgressSection steps={steps} running={running} />
        <FilesSection chatId={chatId} />
        <ContextSection attachments={attachments} />
      </div>
    </div>
  );
}
