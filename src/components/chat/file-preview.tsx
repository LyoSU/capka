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
import { ChevronLeft, ChevronRight, Download, ImageOff, Loader2, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
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
  const [fullscreen, setFullscreen] = useState(false);
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
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 transition-[width,height] duration-200",
          fullscreen
            ? "h-screen w-screen max-w-none rounded-none ring-0 sm:max-w-none"
            : "h-[85vh] max-w-5xl sm:max-w-5xl",
        )}
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
          <button onClick={() => setFullscreen((f) => !f)} aria-label={fullscreen ? t("exitFullscreen") : t("fullscreen")} title={fullscreen ? t("exitFullscreen") : t("fullscreen")} className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
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
    return <ImageViewer file={file} />;
  }
  if (kind === "pdf") {
    // Framed same-origin (allowed via the route's SAMEORIGIN + frame-ancestors
    // 'self'); the response CSP default-src 'none' contains the document.
    return <iframe src={inlineUrl(file)} title={file.name} className="h-full w-full border-0" />;
  }
  if (kind === "html") {
    return <HtmlViewer file={file} />;
  }
  if (kind === "markdown" || kind === "text") {
    return <TextViewer file={file} markdown={kind === "markdown"} />;
  }
  return null; // unreachable — only viewable kinds open the overlay
}

// ── Image viewer ───────────────────────────────────────────────────────────

// The workspace is scratch space, so a thumbnail/preview can resolve to a
// missing or unreachable file. The download route returns 404 (file deleted),
// a 5xx (controller temporarily down — retryable), or other errors. A raw <img>
// would just render the browser's broken-image glyph for all of these, so we
// fetch first to learn *why* it failed and show an honest notice instead.
type ImgState =
  | { state: "loading" }
  | { state: "ok"; url: string }
  | { state: "gone" }       // 404 → file is permanently gone
  | { state: "temporary" }  // 5xx / network → try again shortly
  | { state: "error" };     // anything else

function useFileImage(file: PreviewFile): ImgState {
  const [img, setImg] = useState<ImgState>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    // No synchronous reset to "loading" here — the overlay keys <Viewer> by
    // file.path, so this hook remounts (and useState re-inits) per file.
    (async () => {
      try {
        const res = await fetch(inlineUrl(file));
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          const state = res.status === 404 ? "gone" : res.status >= 500 ? "temporary" : "error";
          if (alive) setImg({ state });
          return;
        }
        url = URL.createObjectURL(await res.blob());
        if (alive) setImg({ state: "ok", url });
        else URL.revokeObjectURL(url);
      } catch {
        // Network blip / aborted fetch — treat as retryable, not a hard error.
        if (alive) setImg({ state: "temporary" });
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  return img;
}

function ImageViewer({ file }: { file: PreviewFile }) {
  const img = useFileImage(file);

  if (img.state === "loading")
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
      </div>
    );
  if (img.state === "ok")
    return (
      <div className="flex h-full items-center justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img.url} alt={file.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  return <UnavailableNotice state={img.state} />;
}

/** Friendly full-pane notice for a file that couldn't be shown, wording the
 *  cause: gone for good, briefly unavailable, or a generic open error. */
function UnavailableNotice({ state }: { state: "gone" | "temporary" | "error" }) {
  const t = useTranslations("chat.preview");
  const Icon = state === "temporary" ? RefreshCw : ImageOff;
  const msg = state === "gone" ? t("gone") : state === "temporary" ? t("temporary") : t("loadError");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/30" aria-hidden />
      <p className="max-w-xs text-sm text-muted-foreground">{msg}</p>
    </div>
  );
}

// ── HTML viewer (rendered in a sandboxed frame, with a source toggle) ──────────

function HtmlViewer({ file }: { file: PreviewFile }) {
  const t = useTranslations("chat.preview");
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const loaded = useFileText(file);

  if (loaded.state === "loading")
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
      </div>
    );
  if (loaded.state === "gone")
    return <p className="p-6 text-center text-sm text-muted-foreground">{t("gone")}</p>;
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

  return (
    <div className="flex h-full flex-col">
      {/* Rendered ⇄ source toggle — a peek at the markup without leaving Quick Look. */}
      <div className="flex shrink-0 items-center gap-0.5 border-b bg-muted/20 px-3 py-1.5">
        {(["rendered", "source"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={cn("rounded-md px-2 py-0.5 text-xs transition-colors",
              mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {m === "rendered" ? t("rendered") : t("source")}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {mode === "rendered" ? (
          // sandbox WITHOUT allow-same-origin → scripts run in an opaque origin and
          // can't reach our cookies, storage, or the parent window. srcDoc sidesteps
          // the download route's script-blocking CSP (that applies to navigations,
          // not to text we fetched and inject here).
          <iframe
            title={file.name}
            srcDoc={loaded.text}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock"
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="h-full overflow-auto">
            <CodeViewer name={file.name} text={loaded.text} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Text / code viewer ───────────────────────────────────────────────────────

type Loaded = { state: "loading" } | { state: "error" } | { state: "gone" } | { state: "too-large" } | { state: "ok"; text: string };

function useFileText(file: PreviewFile): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    setLoaded({ state: "loading" });
    (async () => {
      try {
        const res = await fetch(inlineUrl(file));
        // The workspace is scratch space — an old chat's file may be gone. That's a
        // 404, not a real failure, so show "no longer here", not a scary error.
        if (res.status === 404) {
          await res.body?.cancel().catch(() => {});
          if (alive) setLoaded({ state: "gone" });
          return;
        }
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
  if (loaded.state === "gone")
    return <p className="p-6 text-center text-sm text-muted-foreground">{t("gone")}</p>;
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

// ── File tiles (shared everywhere) ────────────────────────────────────────────

/**
 * A square file tile: a thumbnail with the filename captioned beneath, the way
 * Finder/macOS and chat apps show attachments. One layout shared by the
 * composer, chat history, and the AI's delivered files, so a file looks the same
 * everywhere. Compact and wrap-friendly (vs. full-width rows that push the
 * composer off-screen). The thumb is a slot — callers pass a sandbox FileThumb
 * or a local object-URL preview (for files not yet uploaded).
 */
export function FileTile({
  thumb, name, onClick, href, download, overlay,
}: {
  thumb: React.ReactNode;
  name: string;
  onClick?: () => void;
  href?: string;
  download?: string;
  /** Corner action over the thumbnail (e.g. a remove button in the composer). */
  overlay?: React.ReactNode;
}) {
  const surface = "block aspect-square w-full overflow-hidden rounded-xl ring-1 ring-border/60 bg-muted/40 transition hover:ring-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";
  const square = <div className={surface}>{thumb}</div>;
  const clickable = href ? (
    <a href={href} download={download} className={surface}>{thumb}</a>
  ) : onClick ? (
    <button type="button" onClick={onClick} className={cn(surface, "w-full cursor-pointer")}>{thumb}</button>
  ) : (
    square
  );
  return (
    <div className="group/tile relative w-[88px] shrink-0">
      {clickable}
      {overlay}
      <p title={name} className="mt-1 truncate text-center text-[11px] leading-tight text-muted-foreground">{name}</p>
    </div>
  );
}

/**
 * A sandbox-backed file tile: real thumbnail, Quick Look on click (paging
 * through `viewable`), download fallback for non-previewable kinds. For files
 * addressable on the controller by chatId + path.
 */
export function SandboxFileTile({ file, viewable, overlay }: { file: PreviewFile; viewable: PreviewFile[]; overlay?: React.ReactNode }) {
  const { open } = usePreview();
  const thumb = <FileThumb file={file} className="h-full w-full" />;
  if (previewKind(file.name) !== null) {
    return (
      <FileTile
        thumb={thumb}
        name={file.name}
        overlay={overlay}
        onClick={() => open(viewable, viewable.findIndex((v) => v.path === file.path))}
      />
    );
  }
  return <FileTile thumb={thumb} name={file.name} overlay={overlay} href={downloadUrl(file)} download={file.name} />;
}

// ── Thumbnails ───────────────────────────────────────────────────────────────

/**
 * The visual tile for a file: a real image thumbnail, a peek of text content,
 * or the typed icon — the macOS-Finder feel, decided once here so every file
 * surface looks the same. `className` sets the size and rounding.
 */
export function FileThumb({ file, className }: { file: PreviewFile; className?: string }) {
  const kind = previewKind(file.name);

  if (kind === "image") return <ImageThumb file={file} className={className} />;
  if (kind === "text" || kind === "markdown" || kind === "html") return <TextThumb file={file} className={className} />;

  // Binaries with no in-app viewer (docx, xlsx, zip…): a document glyph instead
  // of a bare icon, so a non-previewable file still reads as a real file.
  return <BinaryFileThumb name={file.name} className={className} />;
}

/**
 * The thumbnail for a file with no in-app preview: a folded-corner sheet tinted
 * in the file type's accent color, with the extension on a badge — the
 * macOS/Drive look. All-SVG so the same glyph stays crisp from a 36px row to an
 * 88px tile. Shared by the chat tiles, the composer, and the workspace panel.
 */
export function BinaryFileThumb({ name, className }: { name: string; className?: string }) {
  const { color } = fileKind(name);
  const ext = (extOf(name) || "file").slice(0, 4).toUpperCase();
  // Longer extensions get a smaller label so it never spills past the badge.
  const fontSize = ext.length <= 2 ? 10 : ext.length === 3 ? 8 : 6.5;
  return (
    <div className={cn("flex items-center justify-center bg-muted/30", className)}>
      <svg viewBox="0 0 40 48" fill="none" aria-hidden className={cn("h-[68%] w-auto", color)}>
        {/* sheet */}
        <path
          d="M9.5 3.5H25L33 11.5V42a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 7 42V6a2.5 2.5 0 0 1 2.5-2.5Z"
          fill="currentColor" fillOpacity="0.12"
          stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" strokeLinejoin="round"
        />
        {/* folded corner */}
        <path d="M25 3.5 33 11.5h-5.5A2.5 2.5 0 0 1 25 9V3.5Z" fill="currentColor" fillOpacity="0.3" />
        {/* extension badge */}
        <rect x="3.5" y="25" width="26" height="13" rx="3" fill="currentColor" />
        <text
          x="16.5" y="31.6" textAnchor="middle" dominantBaseline="central"
          fontSize={fontSize} fontWeight="700" letterSpacing="0.4" fill="#fff"
        >
          {ext}
        </text>
      </svg>
    </div>
  );
}

/**
 * Image thumbnail with a graceful fallback. A bare <img> renders the browser's
 * broken-image glyph when the file is gone or the controller is down; instead we
 * catch the load error and show a neutral "image unavailable" placeholder. The
 * full reason (gone vs temporary) is surfaced in Quick Look — see ImageViewer.
 */
function ImageThumb({ file, className }: { file: PreviewFile; className?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed)
    return (
      <div className={cn("flex items-center justify-center bg-muted/30", className)}>
        <ImageOff className="h-1/3 w-1/3 text-muted-foreground/30" aria-hidden />
      </div>
    );

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={inlineUrl(file)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("object-cover", className)}
    />
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
