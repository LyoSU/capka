"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Download, Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "./markdown";
import { extOf, fileKind, previewKind } from "@/lib/file-kinds";
import { cn } from "@/lib/utils";

/** A file the viewer can open. `chatId` + `path` address it on the controller. */
export type PreviewFile = { path: string; name: string; chatId: string };

// Files larger than this aren't read into the text/markdown viewer — we show a
// "too large" notice with a download instead of pulling megabytes into memory.
const MAX_TEXT_BYTES = 1024 * 1024;

function inlineUrl(f: PreviewFile) {
  return `/api/sandbox/files/download?chatId=${f.chatId}&path=${encodeURIComponent(f.path)}&inline=1`;
}
function downloadUrl(f: PreviewFile) {
  return `/api/sandbox/files/download?chatId=${f.chatId}&path=${encodeURIComponent(f.path)}`;
}

/**
 * Read just the start of a file without downloading the whole thing: pull one
 * chunk off the response stream, then cancel. Lets a thumbnail show real text
 * regardless of file size, with no extra server endpoint.
 */
async function readHead(url: string, maxChars = 600): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error("read failed");
  const reader = res.body.getReader();
  try {
    const { value } = await reader.read();
    return new TextDecoder().decode(value ?? new Uint8Array()).slice(0, maxChars);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

type PreviewCtx = { open: (files: PreviewFile[], index: number) => void };
const PreviewContext = createContext<PreviewCtx | null>(null);

/** Open Quick Look for a file. Must be used within <PreviewProvider>. */
export function usePreview(): PreviewCtx {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error("usePreview must be used within <PreviewProvider>");
  return ctx;
}

export function PreviewProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ files: PreviewFile[]; index: number } | null>(null);

  const open = useCallback((files: PreviewFile[], index: number) => {
    if (files.length === 0) return;
    setState({ files, index: Math.max(0, Math.min(index, files.length - 1)) });
  }, []);
  const close = useCallback(() => setState(null), []);

  const ctx = useMemo(() => ({ open }), [open]);

  return (
    <PreviewContext.Provider value={ctx}>
      {children}
      {state && (
        <FilePreview
          files={state.files}
          index={state.index}
          onIndex={(i) => setState((s) => (s ? { ...s, index: i } : s))}
          onClose={close}
        />
      )}
    </PreviewContext.Provider>
  );
}

// ── Overlay ──────────────────────────────────────────────────────────────────

function FilePreview({
  files,
  index,
  onIndex,
  onClose,
}: {
  files: PreviewFile[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations("chat.preview");
  const file = files[index];
  const many = files.length > 1;
  const go = useCallback(
    (delta: number) => onIndex((index + delta + files.length) % files.length),
    [index, files.length, onIndex],
  );

  // Arrow keys page through the set, the way Quick Look does. Esc is handled by
  // the dialog itself via onOpenChange.
  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [many, go]);

  const kind = previewKind(file.name);
  const { label } = fileKind(file.name);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[85vh] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-medium">{file.name}</DialogTitle>
            <p className="text-xs text-muted-foreground">
              {label}
              {many ? ` · ${index + 1}/${files.length}` : ""}
            </p>
          </div>
          {many && (
            <div className="flex items-center gap-0.5">
              <button onClick={() => go(-1)} aria-label={t("prev")} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button onClick={() => go(1)} aria-label={t("next")} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
          <a href={downloadUrl(file)} download={file.name} aria-label={t("download")} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <Download className="h-4 w-4" />
          </a>
          <button onClick={onClose} aria-label={t("close")} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — keyed by path so switching files remounts the viewer cleanly */}
        <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
          <Viewer key={file.path} file={file} kind={kind} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Viewer({ file, kind }: { file: PreviewFile; kind: ReturnType<typeof previewKind> }) {
  if (kind === "image") {
    return (
      <div className="flex h-full items-center justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={inlineUrl(file)} alt={file.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (kind === "pdf") {
    // Framed same-origin (allowed via the route's SAMEORIGIN + frame-ancestors
    // 'self'); the response CSP default-src 'none' contains the document.
    return <iframe src={inlineUrl(file)} title={file.name} className="h-full w-full border-0" />;
  }
  if (kind === "markdown" || kind === "text") {
    return <TextViewer file={file} markdown={kind === "markdown"} />;
  }
  return null; // unreachable — only viewable kinds open the overlay
}

// ── Text / code viewer ───────────────────────────────────────────────────────

type Loaded = { state: "loading" } | { state: "error" } | { state: "too-large" } | { state: "ok"; text: string };

function useFileText(file: PreviewFile): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    setLoaded({ state: "loading" });
    (async () => {
      try {
        const res = await fetch(inlineUrl(file));
        if (!res.ok) throw new Error("fetch failed");
        const len = Number(res.headers.get("Content-Length") || 0);
        if (len > MAX_TEXT_BYTES) {
          await res.body?.cancel().catch(() => {});
          if (alive) setLoaded({ state: "too-large" });
          return;
        }
        const text = await res.text();
        if (alive) setLoaded({ state: "ok", text });
      } catch {
        if (alive) setLoaded({ state: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [file]);
  return loaded;
}

function TextViewer({ file, markdown }: { file: PreviewFile; markdown: boolean }) {
  const t = useTranslations("chat.preview");
  const loaded = useFileText(file);

  if (loaded.state === "loading")
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
      </div>
    );
  if (loaded.state === "error")
    return <p className="p-6 text-center text-sm text-muted-foreground">{t("loadError")}</p>;
  if (loaded.state === "too-large")
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t("tooLarge")}</p>
        <a href={downloadUrl(file)} download={file.name} className="text-sm font-medium text-primary hover:underline">
          {t("download")}
        </a>
      </div>
    );

  if (markdown)
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Markdown>{loaded.text}</Markdown>
      </div>
    );
  return <CodeViewer name={file.name} text={loaded.text} />;
}

// Lazy, shared Shiki highlighter import — same off-critical-path trick markdown.tsx
// uses for its plugins, so the chat bundle stays small until the viewer opens.
let highlightPromise: Promise<(code: string, lang: string) => Promise<string>> | null = null;
function loadHighlighter() {
  highlightPromise ??= import("shiki").then((shiki) => (code: string, lang: string) =>
    shiki.codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light",
    }).catch(() =>
      // Unknown grammar → fall back to plain text rather than throwing.
      shiki.codeToHtml(code, {
        lang: "text",
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: "light",
      }),
    ),
  );
  return highlightPromise;
}

function CodeViewer({ name, text }: { name: string; text: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const lang = extOf(name) || "text";

  useEffect(() => {
    let alive = true;
    loadHighlighter()
      .then((hl) => hl(text, lang))
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml(null));
    return () => {
      alive = false;
    };
  }, [text, lang]);

  // Until Shiki arrives (or if it fails), show the raw text — never a blank pane.
  if (html === null)
    return <pre className="ql-plain overflow-auto p-4 text-xs leading-relaxed">{text}</pre>;

  // Safe: this HTML is produced by Shiki, which HTML-escapes the file's text
  // before wrapping it in <span> tags — the markup is generated, not user-authored
  // (same pattern Streamdown already uses to render code in chat). No raw file
  // HTML is ever interpreted, so no sanitizer is needed here.
  return <div className="ql-code overflow-auto text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Thumbnails ───────────────────────────────────────────────────────────────

/**
 * The visual tile for a file: a real image thumbnail, a peek of text content,
 * or the typed icon — the macOS-Finder feel, decided once here so every file
 * surface looks the same. `className` sets the size and rounding.
 */
export function FileThumb({ file, className }: { file: PreviewFile; className?: string }) {
  const kind = previewKind(file.name);
  const { Icon, color, bg } = fileKind(file.name);

  if (kind === "image")
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={inlineUrl(file)} alt="" loading="lazy" className={cn("object-cover", className)} />;
  if (kind === "text" || kind === "markdown") return <TextThumb file={file} className={className} />;

  return (
    <div className={cn("flex items-center justify-center", bg, className)}>
      <Icon className={cn("h-4 w-4", color)} />
    </div>
  );
}

function TextThumb({ file, className }: { file: PreviewFile; className?: string }) {
  const { Icon, color, bg } = fileKind(file.name);
  const [head, setHead] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    readHead(inlineUrl(file))
      .then((h) => alive && setHead(h))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [file]);

  if (failed || head === "")
    return (
      <div className={cn("flex items-center justify-center", bg, className)}>
        <Icon className={cn("h-4 w-4", color)} />
      </div>
    );

  return (
    <div className={cn("relative overflow-hidden bg-background ring-1 ring-border/60", className)}>
      <pre className="whitespace-pre-wrap break-all p-1 font-mono text-[3px] leading-[1.3] text-foreground/70">
        {head ?? ""}
      </pre>
      {/* Fade the bottom so the clipped text reads as a peek, not a cut-off. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />
    </div>
  );
}
