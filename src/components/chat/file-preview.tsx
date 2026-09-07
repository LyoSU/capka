"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileWarning, ImageOff, Loader2, Maximize2, Minimize2, RefreshCw, Sparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Hint } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { Markdown } from "./markdown";
import { useChatDraft } from "./use-chat-draft";
import { extOf, fileKind, previewKind } from "@/lib/file-kinds";
import { fileStatusFromHttp, type FileStatus } from "@/lib/chat/file-status";
import { applyGesture, swipeVerdict, tapZoomTarget, wheelZoomFactor, TAP_SLOP_PX, type Geometry, type Point } from "@/lib/chat/image-view";
import { formatSize } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";

/** A file the viewer can open. `path` plus its workspace address (a chat's own
 *  workspace via `chatId`, or a project's shared one via `projectId` — exactly one)
 *  locate it on the controller. Chat surfaces pass `chatId` as before; the project
 *  hub's file browser passes `projectId`. */
export type PreviewFile = { path: string; name: string; chatId?: string; projectId?: string; shared?: boolean };

/** The workspace-address query fragment for a file (`projectId=…` or `chatId=…`). */
function fileQuery(f: PreviewFile): string {
  return f.projectId
    ? `projectId=${encodeURIComponent(f.projectId)}`
    : `chatId=${encodeURIComponent(f.chatId ?? "")}`;
}

// Files larger than this aren't read into the text/markdown viewer — we show a
// "too large" notice with a download instead of pulling megabytes into memory.
const MAX_TEXT_BYTES = 1024 * 1024;

function inlineUrl(f: PreviewFile) {
  return f.shared
    ? `/api/sandbox/shared/download?path=${encodeURIComponent(f.path)}&inline=1`
    : `/api/sandbox/files/download?${fileQuery(f)}&path=${encodeURIComponent(f.path)}&inline=1`;
}
function downloadUrl(f: PreviewFile) {
  return f.shared
    ? `/api/sandbox/shared/download?path=${encodeURIComponent(f.path)}`
    : `/api/sandbox/files/download?${fileQuery(f)}&path=${encodeURIComponent(f.path)}`;
}

// One shared, cached status probe for a workspace file — the single source of
// truth for "does this file exist / can it be opened", used by the PDF viewer,
// the inline `/workspace/…` chips, and the artifact tiles so all three agree.
// It fetches only the headers (the body is cancelled immediately), then maps the
// response through the same classifier everywhere (see fileStatusFromHttp).
//
// Only *positive* results are remembered (presentFiles): a known-present file is
// never re-probed, so the chip and tile for it share one request, and re-renders
// (one per streamed token) never re-hit the controller. A "gone" verdict is
// deliberately NOT cached — the same path can be re-created in a later turn, and
// a stale negative would wrongly grey out a real file — so it is re-checked on
// each mount. Cheap: only "gone" changes rendering; "ok" and "checking" look the
// same (present and clickable).
const presentFiles = new Set<string>();
// `\0` as the escape, not a literal NUL character. The separator itself is a good
// choice — no id or path can contain it, so two files can never collide on a
// composed key — but it was previously typed into the template as a raw byte, which
// made git classify this entire file as BINARY: no diffs, and `grep -n` skipped it.
// A 776-line component had quietly opted out of code review.
const fileStatusKey = (f: PreviewFile) => `${f.projectId ?? f.chatId}\0${f.path}`;

/** Probe a workspace file's status. `enabled` gates the probe off while a reply
 *  is still streaming: a file the model is about to write shouldn't flash as
 *  "missing" before its write lands, so we judge existence only once the turn is
 *  final. While disabled the hook reports "ok" (optimistic). Returns "checking"
 *  until the first probe settles. */
export function useFileStatus(file: PreviewFile, enabled = true): "checking" | FileStatus {
  const key = fileStatusKey(file);
  const [status, setStatus] = useState<"checking" | FileStatus>(() => (presentFiles.has(key) ? "ok" : "checking"));
  // The key (chat+path) drives the effect — not `file`, which is a fresh object
  // every render — so the probe fires once per file, not once per render.
  useEffect(() => {
    if (!enabled || presentFiles.has(key)) return;
    let alive = true;
    (async () => {
      let result: FileStatus;
      try {
        const res = await fetch(inlineUrl(file));
        await res.body?.cancel().catch(() => {});
        result = fileStatusFromHttp(res.status);
      } catch {
        result = "temporary"; // network blip — retryable, not a hard miss
      }
      if (result === "ok") presentFiles.add(key);
      if (alive) setStatus(result);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `file` is derivable from `key`; depending on it would re-fire every render
  }, [key, enabled]);
  return enabled ? status : "ok";
}

/**
 * Is this file still there? For restoring a viewer that was open when the tab was
 * closed — a workspace is scratch space and may have been cleaned out since.
 *
 * Returns the same verdict every other surface reads, because the difference
 * matters here: `gone` means forget the stored path, while `temporary` means the
 * controller is momentarily unreachable and the path is still good. A positive
 * answer is remembered the way the status hook remembers one, so the viewer that
 * opens next does not ask a second time.
 */
export async function probeFile(file: PreviewFile): Promise<FileStatus> {
  try {
    const res = await fetch(inlineUrl(file));
    await res.body?.cancel().catch(() => {});
    const verdict = fileStatusFromHttp(res.status);
    if (verdict === "ok") presentFiles.add(fileStatusKey(file));
    return verdict;
  } catch {
    return "temporary";
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

type PreviewCtx = { open: (files: PreviewFile[], index: number) => void };
const PreviewContext = createContext<PreviewCtx | null>(null);

type PreviewState = { files: PreviewFile[]; index: number };

/** What a host column needs to render the viewer itself, and how it says it can.
 *  `state` is non-null only while the CURRENT preview belongs to that host. */
type PreviewDockCtx = {
  register: (host: (() => void) | null) => void;
  state: PreviewState | null;
  /** True while the docked preview is showing full-window instead of in the
   *  column. The state stays with the PREVIEW, not the column, so paging through
   *  a set keeps the size the reader asked for. */
  maximized: boolean;
  maximize: () => void;
  setIndex: (i: number) => void;
  close: () => void;
};
const PreviewDockContext = createContext<PreviewDockCtx | null>(null);

/** Open Quick Look for a file. Must be used within <PreviewProvider>. */
export function usePreview(): PreviewCtx {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error("usePreview must be used within <PreviewProvider>");
  return ctx;
}

/**
 * Offer a column as the place previews open, instead of a dialog over the page.
 *
 * `onRequestOpen` is how the provider asks that column to appear — a file opened
 * from a message tile has to bring the panel with it. Registration is what makes
 * the difference: the project hub mounts the same provider with no host, so its
 * previews stay dialogs, and so do everyone's on a phone.
 */
export function usePreviewDock(onRequestOpen?: () => void): PreviewDockCtx | null {
  const ctx = useContext(PreviewDockContext);
  // The callback is a fresh closure every render; the registration must not be.
  const cb = useRef(onRequestOpen);
  cb.current = onRequestOpen;
  const register = ctx?.register;
  // A host with no way to make itself appear must NOT register, and this is the
  // one place that can tell. Registering anyway would take ownership of the
  // preview — the provider would mark it docked and skip the dialog — and then
  // fail to open the column, so clicking a file in the transcript would do
  // nothing at all, visibly. Falling back to the dialog is a worse layout and an
  // infinitely better outcome than a dead click.
  const canOpen = !!onRequestOpen;
  useEffect(() => {
    if (!register || !canOpen) return;
    register(() => cb.current?.());
    return () => register(null);
  }, [register, canOpen]);
  return ctx;
}

export function PreviewProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PreviewState | null>(null);
  // Whether the preview currently open belongs to a host column. Decided once,
  // when it opens: a window crossing the breakpoint mid-read shouldn't tear the
  // viewer out from under the reader and re-open it somewhere else.
  const [docked, setDocked] = useState(false);
  // Full-window, for a wide table or a long report that a 20rem column cramps.
  // Deliberately NOT remembered across files: opening a file from the transcript
  // always lands in the column, because a sticky answer here would quietly
  // restore the covers-the-chat default that docking exists to replace.
  const [maximized, setMaximized] = useState(false);
  const host = useRef<(() => void) | null>(null);
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  const open = useCallback((files: PreviewFile[], index: number) => {
    if (files.length === 0) return;
    // A phone has no room to dock beside anything — the sheet covers the chat
    // there anyway, so the dialog is still the honest shape.
    const dock = isMobileRef.current ? null : host.current;
    setDocked(!!dock);
    setMaximized(false);
    dock?.();
    setState({ files, index: Math.max(0, Math.min(index, files.length - 1)) });
  }, []);
  const close = useCallback(() => {
    setState(null);
    setMaximized(false);
  }, []);
  const maximize = useCallback(() => setMaximized(true), []);
  const restore = useCallback(() => setMaximized(false), []);
  const setIndex = useCallback((i: number) => setState((s) => (s ? { ...s, index: i } : s)), []);
  const register = useCallback((fn: (() => void) | null) => {
    host.current = fn;
  }, []);

  const ctx = useMemo(() => ({ open }), [open]);
  // `state` stays non-null while maximized even though the column is not drawing
  // it: the column is what remembers which file is open for this chat, and going
  // full-window must not read as having closed the file.
  const dockCtx = useMemo<PreviewDockCtx>(
    () => ({ register, state: docked ? state : null, maximized, maximize, setIndex, close }),
    [register, docked, state, maximized, maximize, setIndex, close],
  );

  return (
    <PreviewContext.Provider value={ctx}>
      <PreviewDockContext.Provider value={dockCtx}>
        {children}
        {/* One dialog, two jobs. For a host with no column it is the whole
            viewer. For the docked column it is the full-window size, promoted
            by the reader — so its restore control goes back to the column
            rather than to a smaller dialog, and Escape steps down one rung of
            the same ladder the column already uses. */}
        {state && (!docked || maximized) && (
          <FilePreview
            files={state.files}
            index={state.index}
            onIndex={setIndex}
            onClose={close}
            forceFullscreen={docked && maximized}
            onRestore={docked && maximized ? restore : undefined}
          />
        )}
      </PreviewDockContext.Provider>
    </PreviewContext.Provider>
  );
}

/**
 * The viewer as a column, not a dialog — the workspace panel's other face.
 *
 * The header is deliberately slimmer than the dialog's: in a docked column the
 * file's own content is the scarce thing, and there is no fullscreen toggle
 * because the column IS the size the user chose. Back and Close are different
 * exits and both are offered — one returns to the file list, the other puts the
 * whole column away.
 */
export function DockedPreview({
  files,
  index,
  onIndex,
  onBack,
  onClose,
  onMaximize,
  selectionBar,
  className,
}: {
  files: PreviewFile[];
  index: number;
  onIndex: (i: number) => void;
  /** Back to the file list, leaving the column open. */
  onBack: () => void;
  /** Put the whole column away. */
  onClose: () => void;
  /** Show this file full-window instead. Omitted where there is nowhere to grow. */
  onMaximize?: () => void;
  /** Built per file by the host, which is the thing that owns the composer. */
  selectionBar?: (fileName: string) => React.ReactNode;
  className?: string;
}) {
  const t = useTranslations("chat.preview");
  const tw = useTranslations("chat.workspace");
  const file = files[index];
  const many = files.length > 1;
  const kind = previewKind(file.name);
  // "Open in a new tab" is offered only for what a browser will actually SHOW.
  // Anything else is served as application/octet-stream under `nosniff`, so the
  // click downloads the file — two buttons in one row doing the same thing, one
  // of them under a label that promises otherwise. Download is still right there
  // for those files, which is what they need anyway.
  const opensInTab = kind === "image" || kind === "pdf" || kind === "text" || kind === "markdown";
  const go = useCallback(
    (delta: number) => onIndex((index + delta + files.length) % files.length),
    [index, files.length, onIndex],
  );

  // Escape steps back to the files, one level — it does NOT close the column.
  // A reader who opened a file from the list expects to land back on the list,
  // and the dialog's habit of dismissing everything is exactly what docking is
  // meant to stop. Arrow keys page through the set as they do in the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onBack();
      } else if (many && e.key === "ArrowLeft") go(-1);
      else if (many && e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [many, go, onBack]);

  // The viewer takes focus when it opens so Escape and the arrows reach it
  // without a click first, and so a keyboard user isn't left on a control that
  // the browser just replaced.
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    paneRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={paneRef} tabIndex={-1} className={cn("flex h-full min-w-0 flex-col bg-card outline-none", className)}>
      <div className="flex items-center gap-1 border-b px-2 py-2">
        <HeaderButton onClick={onBack} label={tw("backToFiles")}>
          <ChevronLeft className="h-4 w-4" />
        </HeaderButton>
        <p className="min-w-0 flex-1 truncate text-sm font-medium" title={file.name}>
          {file.name}
        </p>
        {many && (
          <>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {index + 1}/{files.length}
            </span>
            <HeaderButton onClick={() => go(-1)} label={t("prev")}><ChevronLeft className="h-4 w-4" /></HeaderButton>
            <HeaderButton onClick={() => go(1)} label={t("next")}><ChevronRight className="h-4 w-4" /></HeaderButton>
          </>
        )}
        {opensInTab && (
          <HeaderButton href={inlineUrl(file)} target="_blank" label={t("openInNewTab")}>
            <ExternalLink className="h-4 w-4" />
          </HeaderButton>
        )}
        <HeaderButton href={downloadUrl(file)} download={file.name} label={t("download")}>
          <Download className="h-4 w-4" />
        </HeaderButton>
        {/* Grows the file to the whole window without leaving the app: a tab
            hands the file to the browser, this keeps Markdown rendered and the
            file set pageable. */}
        {onMaximize && (
          <HeaderButton onClick={onMaximize} label={t("fullscreen")}>
            <Maximize2 className="h-4 w-4" />
          </HeaderButton>
        )}
        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
        <HeaderButton onClick={onClose} label={t("close")}>
          <X className="h-4 w-4" />
        </HeaderButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
        <Viewer key={file.path} file={file} kind={kind} onClose={onBack} onPage={many ? go : undefined} selectionBar={selectionBar?.(file.name)} />
      </div>
    </div>
  );
}

// ── Overlay ──────────────────────────────────────────────────────────────────

function FilePreview({
  files,
  index,
  onIndex,
  onClose,
  forceFullscreen = false,
  onRestore,
}: {
  files: PreviewFile[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Open already full-window: this dialog was promoted from a docked column. */
  forceFullscreen?: boolean;
  /** Where "smaller" goes when there is a column to go back to. Present only for
   *  a promoted preview; without it the toggle is the dialog's own two sizes. */
  onRestore?: () => void;
}) {
  const t = useTranslations("chat.preview");
  const [wide, setWide] = useState(forceFullscreen);
  // A phone has one size for a file: the whole screen. The 85dvh sheet left a strip
  // of chat above it that nothing could be done with, and the toggle that grew it
  // was a tap the person had to make every single time — so there is no toggle.
  const isMobile = useIsMobile();
  const fullscreen = isMobile || wide;
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
  const { labelKey } = fileKind(file.name);

  return (
    // Escape and the backdrop step down ONE rung: back to the column for a
    // promoted preview, all the way out for a dialog that is the only host.
    <Dialog open onOpenChange={(o) => !o && (onRestore ?? onClose)()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          // The transition lists the properties that actually change between the
          // two states. It used to name `width`, which neither state sets, while
          // the real switch happens on max-width — so the resize simply jumped.
          "flex flex-col gap-0 overflow-hidden p-0 transition-[height,max-width] duration-200 motion-reduce:transition-none",
          // dvh, not vh: mobile Safari's `vh` ignores browser chrome, so the dialog
          // ran off the bottom of the screen with its footer controls under the
          // toolbar and nothing to scroll.
          fullscreen
            ? "h-dvh w-screen max-w-none rounded-none ring-0 sm:max-w-none"
            : "h-[85dvh] max-w-5xl sm:max-w-5xl",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-medium">{file.name}</DialogTitle>
            <p className="text-xs text-muted-foreground">
              {t(`kind.${labelKey}`)}
              {many ? ` · ${index + 1}/${files.length}` : ""}
            </p>
          </div>
          {many && (
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
              <HeaderButton onClick={() => go(-1)} label={t("prev")}><ChevronLeft className="h-4 w-4" /></HeaderButton>
              <HeaderButton onClick={() => go(1)} label={t("next")}><ChevronRight className="h-4 w-4" /></HeaderButton>
            </div>
          )}
          {!isMobile && (
            <HeaderButton onClick={onRestore ?? (() => setWide((f) => !f))} label={fullscreen ? t("exitFullscreen") : t("fullscreen")}>
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </HeaderButton>
          )}
          <HeaderButton href={downloadUrl(file)} download={file.name} label={t("download")}>
            <Download className="h-4 w-4" />
          </HeaderButton>
          {/* Close is separated on purpose: it sat flush against Download as a
              fifth identical glyph, so the one irreversible-feeling action in the
              row was the easiest one to hit by accident. */}
          <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
          <HeaderButton onClick={onClose} label={t("close")}>
            <X className="h-4 w-4" />
          </HeaderButton>
        </div>

        {/* Body — keyed by path so switching files remounts the viewer cleanly */}
        <div className="min-h-0 flex-1 overflow-auto bg-muted/10">
          <Viewer key={file.path} file={file} kind={kind} onClose={onClose} onPage={many ? go : undefined} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One 28px ghost control in the Quick Look header — a button, or a link when
 *  `href` is set. Five copies of the same class string lived here inline, which is
 *  how Download and Close drifted into looking identical. */
function HeaderButton({
  label, children, onClick, href, download, target,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  download?: string;
  target?: string;
}) {
  const cls =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  return (
    <Hint label={label} side="bottom">
      {href ? (
        <a href={href} download={download} target={target} rel={target ? "noopener noreferrer" : undefined} className={cls}>{children}</a>
      ) : (
        <button type="button" onClick={onClick} className={cls}>{children}</button>
      )}
    </Hint>
  );
}

function Viewer({ file, kind, onClose, onPage, selectionBar }: {
  file: PreviewFile;
  kind: ReturnType<typeof previewKind>;
  onClose: () => void;
  /** Present only when there is more than one file to page between. */
  onPage?: (delta: number) => void;
  /** The highlight-to-quote bar, built by a host that has a composer to fill.
   *  The dialog host can float over a page with no chat under it (the project
   *  hub, the settings pages) and passes nothing. */
  selectionBar?: React.ReactNode;
}) {
  if (kind === "image") {
    return <ImageViewer file={file} onPage={onPage} />;
  }
  if (kind === "pdf") {
    return <PdfViewer file={file} />;
  }
  if (kind === "html") {
    return <HtmlViewer file={file} />;
  }
  if (kind === "markdown" || kind === "text") {
    return <TextViewer file={file} markdown={kind === "markdown"} selectionBar={selectionBar} />;
  }
  // No in-app viewer for this format. Reached on purpose now: clicking such a file
  // used to start a download with no warning in the grid and do nothing at all in
  // the list, so the same file behaved two different wrong ways. Every file opens
  // here instead, and this pane says what it is and offers the ways out.
  return <UnsupportedViewer file={file} onClose={onClose} />;
}

/**
 * The pane for a format with no viewer — docx, xlsx, zip, video, audio.
 *
 * Offers two ways forward, and the second one is the point: the sandbox has
 * LibreOffice and ffmpeg, so the assistant can usually produce a version that
 * *does* open here. Rather than converting silently on open (a click that quietly
 * spins up a container and spends sandbox time is exactly the surprise this
 * audience shouldn't get), it fills the message box and lets the user press send —
 * they see what is about to be asked.
 */
function UnsupportedViewer({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const t = useTranslations("chat.preview");
  const { labelKey } = fileKind(file.name);
  const [size, setSize] = useState<number | null>(null);
  // `file.chatId` is absent in the project hub's file browser, where there is no
  // composer to fill — so the convert offer only exists where it can be honored.
  const { setDraft } = useChatDraft(file.chatId ?? "");

  // Header-only probe for the size: worth knowing before deciding to download a
  // file the app can't show, and the body is cancelled straight away.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(inlineUrl(file));
        await res.body?.cancel().catch(() => {});
        const len = Number(res.headers.get("Content-Length") || 0);
        if (alive && len > 0) setSize(len);
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [file]);

  const askConvert = () => {
    // Appended, never overwriting: the user may already have a half-typed message.
    setDraft((cur) => (cur.trim() ? `${cur.trim()}\n\n` : "") + t("askConvertPrompt", { name: file.name }));
    onClose();
    toast.success(t("askConvertDone"));
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <BinaryFileThumb name={file.name} className="h-24 w-24 rounded-xl" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("noPreview")}</p>
        <p className="text-xs text-muted-foreground">
          {t(`kind.${labelKey}`)}
          {size !== null ? ` · ${formatSize(size)}` : ""}
        </p>
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">{t("noPreviewHint")}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {/* A native <a download>, styled as the primary button — the repo's way of
            making a real link look like one (base-ui's Button has no `asChild`). */}
        <a href={downloadUrl(file)} download={file.name} className={cn(buttonVariants({ size: "sm" }))}>
          <Download className="h-4 w-4" />
          {t("download")}
        </a>
        {file.chatId && (
          <Button variant="outline" size="sm" onClick={askConvert}>
            <Sparkles className="h-4 w-4" />
            {t("askConvert")}
          </Button>
        )}
      </div>
    </div>
  );
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
          // Same classifier the chips, tiles and PDF viewer use (never "ok" here
          // since the response failed) — one verdict for a file across the app.
          const fs = fileStatusFromHttp(res.status);
          if (alive) setImg({ state: fs === "ok" ? "error" : fs });
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

/** How far a swipe travels before the outgoing image is at its dimmest. */
const SWIPE_FADE_PX = 320;

/** The frame's own centre — where a command that has no pointer behind it (a
 *  button, a key, a re-fit) anchors its zoom. */
const ORIGIN: Point = { x: 0, y: 0 };

/** Safari's proprietary pinch event. Not in lib.dom, and only Safari fires it. */
type SafariGestureEvent = Event & { scale: number; clientX: number; clientY: number };

/**
 * Image pane with zoom and pan. Fit-to-window alone is not a viewer: a chart, a
 * scan or a screenshot is precisely the thing someone opens in order to read
 * something small in it, and `object-contain` at 85vh offered no way in.
 *
 * The arithmetic — anchoring, bounds, the wheel curve — lives in
 * `lib/chat/image-view.ts`, where it is tested against numbers instead of a DOM.
 * What is left here is the part that is genuinely about the platform.
 *
 * FOUR WAYS IN, ONE WRITER. Wheel, pinch, drag and the buttons all end at
 * `apply`, the only thing that touches `view`, so all four get the same bounds
 * check and the same anchoring. They used to be two paths that agreed about
 * neither.
 *
 * WHO REPORTS A PINCH, AND HOW. Chrome, Edge and Firefox deliver a trackpad
 * pinch as a wheel event with `ctrlKey` set — a lie they tell on purpose, and
 * the closest thing to a standard here. Safari on macOS does not: it has its own
 * `gesturestart`/`gesturechange` carrying an accumulated `scale`, and an
 * implementation that only listens for ctrl-wheel leaves Mac Safari users
 * pinching the whole browser instead of the picture. Touchscreens are neither,
 * and are handled from raw pointers below.
 */
function ImageViewer({ file, onPage }: { file: PreviewFile; onPage?: (delta: number) => void }) {
  const t = useTranslations("chat.preview");
  const img = useFileImage(file);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0, animate: false });
  const [dragging, setDragging] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  // Every pointer currently down on the frame: one is a drag, two are a pinch.
  // Keeping the whole set (rather than a single "last position") is what lets a
  // finger join or leave mid-gesture without the image jumping.
  const pointers = useRef(new Map<number, Point>());
  // What the next move is measured against — a lone pointer's position, or the
  // midpoint and spread of two.
  const gesture = useRef<{ at: Point; spread: number } | null>(null);
  // A one-finger drag across a FITTED image pages to the next file rather than
  // panning: at fit there is nothing to pan to, and sideways is how a stack of
  // photos is read on a phone. `dx` follows the finger, so the gesture is visible
  // while it is being made and can be called off by simply not letting go.
  const [swipeX, setSwipeX] = useState(0);
  // The pane width belongs to the ref, not to state: a fast tap can end before
  // React has re-rendered, and a threshold measured against a width of 0 is no
  // threshold at all — every twitch would page.
  const swiping = useRef<{ x: number; y: number; at: number; width: number } | null>(null);
  // Where the lone pointer went down, so letting go without having travelled can
  // be told apart from the end of a pan. Cleared the moment a second pointer
  // joins: a pinch is never a click. The pointer type rides along because a
  // mouse click zooms while a finger's single tap does not (a tap is how a swipe
  // starts, and touch has double-tap for this).
  const tap = useRef<{ at: Point; x: number; y: number; type: string } | null>(null);
  // `dblclick` is a MouseEvent with no pointer type of its own; this is the type
  // of the last pointer that touched the frame, which is what produced it.
  const lastPointerType = useRef("");

  const geometry = useCallback((): Geometry | null => {
    const el = picture.current;
    const box = frame.current;
    if (!el || !box) return null;
    return {
      image: { w: el.offsetWidth, h: el.offsetHeight },
      frame: { w: box.clientWidth, h: box.clientHeight },
      naturalWidth: el.naturalWidth,
    };
  }, []);

  /**
   * The single writer. Takes the NEXT scale as a function of the current one and
   * resolves it inside the updater, so no caller ever reads `view.scale` from its
   * closure — that is what lets the listeners below be bound once, with no
   * dependency on the live scale, and it removes the class of bug where the scale
   * and the offset are computed from two different renders' values. The geometry
   * is read in the same place, for the same reason.
   */
  const apply = useCallback(
    (next: (cur: number, g: Geometry) => number, from: Point, to: Point, animate: boolean) => {
      setView((v) => {
        const g = geometry();
        if (!g) return v;
        const moved = applyGesture(v, g, next(v.scale, g), from, to);
        // Dragging against a bound, or a resize that changed nothing, must not
        // re-render sixty times a second to say so.
        if (moved.scale === v.scale && moved.x === v.x && moved.y === v.y && animate === v.animate) return v;
        return { ...moved, animate };
      });
    },
    [geometry],
  );

  /** A client point in the frame's coordinates, measured from its centre — which
   *  is where the transform's origin sits. See the note in `image-view.ts`. */
  const framePoint = (e: { clientX: number; clientY: number }, el: HTMLElement): Point => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  /** The anchor of whatever is touching the frame right now. */
  const readGesture = () => {
    const pts = [...pointers.current.values()];
    if (pts.length === 0) return null;
    if (pts.length === 1) return { at: pts[0], spread: 0 };
    return {
      at: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      spread: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
    };
  };

  // Bound by hand rather than with onWheel, because React registers wheel handlers
  // as PASSIVE: `preventDefault` inside a React onWheel is ignored (with a console
  // warning) and the dialog scrolls behind the zoom. Re-runs when the image
  // arrives, since the frame does not exist during the loading state.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const at = framePoint(e, el);
      apply((cur) => cur * wheelZoomFactor(e), at, at, false);
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    // Safari's own pinch, wanted for opposite reasons on its two platforms. On
    // macOS this is the ONLY signal, so it drives the zoom. On iOS the pointers
    // below already do that and these listeners exist purely to refuse the
    // event: `touch-action: none` does not stop iOS from zooming the page —
    // Safari keeps that gesture for accessibility — and preventing
    // `gesturestart` is Apple's documented way to take it back. macOS Safari is
    // the one engine with GestureEvent and no TouchEvent, which is the feature
    // test for "drives the zoom" versus "is only suppressed".
    const drivesZoom = "GestureEvent" in window && !("TouchEvent" in window);
    let anchor = ORIGIN;
    let reported = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      anchor = framePoint(e as SafariGestureEvent, el);
      reported = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (!drivesZoom) return;
      const g = e as SafariGestureEvent;
      // `scale` accumulates from the start of the gesture, so the step is the
      // ratio against what it said last time.
      const factor = reported > 0 ? g.scale / reported : 1;
      const at = framePoint(g, el);
      reported = g.scale;
      apply((cur) => cur * factor, anchor, at, false);
      anchor = at;
    };
    const onGestureEnd = (e: Event) => e.preventDefault();
    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    el.addEventListener("gestureend", onGestureEnd, { passive: false });

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, [apply, img.state]);

  // Going fullscreen re-fits the image: a pan that was legal is now out of
  // bounds, and a scale that was 1:1 no longer is. Re-running the clamp with the
  // anchor at the centre leaves a view that is still legal exactly as it was.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => apply((cur) => cur, ORIGIN, ORIGIN, true));
    ro.observe(el);
    return () => ro.disconnect();
  }, [apply, img.state]);

  if (img.state === "loading")
    return <ViewerLoading />;
  if (img.state !== "ok") return <UnavailableNotice state={img.state} />;

  const zoomed = view.scale > 1;
  const step = (factor: number) => apply((cur) => cur * factor, ORIGIN, ORIGIN, true);
  const nudge = (x: number, y: number) => apply((cur) => cur, ORIGIN, { x, y }, true);
  // Let go: the swipe offset eases back to nothing rather than being cut to it.
  // The re-clamp is a no-op that exists to turn the easing back on through the
  // one writer, instead of giving `animate` a second one.
  const settle = () => {
    if (swipeX) setSwipeX(0);
    apply((cur) => cur, ORIGIN, ORIGIN, true);
  };
  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    pointers.current.delete(e.pointerId);
    // Lifting one finger of a pinch must not teleport the image: the survivor
    // becomes the new anchor rather than the now-meaningless midpoint.
    gesture.current = readGesture();
    setDragging(pointers.current.size === 1);

    const started = swiping.current;
    swiping.current = null;
    // A mouse button released where it was pressed is a click, and the cursor
    // has been promising one zooms. Touch is left out on purpose: see `tap`.
    const pressed = tap.current;
    if (pressed && pointers.current.size === 0) {
      tap.current = null;
      if (pressed.type === "mouse" && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) < TAP_SLOP_PX) {
        apply((cur, g) => tapZoomTarget(g, cur), pressed.at, pressed.at, true);
        return;
      }
    }
    if (started && onPage) {
      const delta = swipeVerdict({
        dx: e.clientX - started.x,
        dy: e.clientY - started.y,
        elapsedMs: e.timeStamp - started.at,
        width: started.width,
      });
      // `FilePreview` keys the viewer by path, so paging unmounts this one and
      // there is nothing left here to tidy up.
      if (delta) return onPage(delta);
    }
    settle();
  };

  return (
    // The controls are a SIBLING of the zoom surface, not a child of it. As a
    // child, every click on them bubbled into the surface's own handlers: a
    // double-click on "+" reached `onDoubleClick` and reset the zoom, so the
    // buttons fought whoever used them twice in a row.
    <div className="relative h-full">
      <div
        ref={frame}
        // The whole frame is the zoom surface, and it takes focus so +/-/0 and
        // the arrows reach it.
        tabIndex={0}
        // `group`, NOT `img`: role="img" makes every descendant presentational,
        // which would hide the zoom controls from assistive tech entirely. The
        // picture itself is named by the <img>'s own alt.
        role="group"
        aria-label={file.name}
        onDoubleClick={(e) => {
          // Touch and pen only: on a mouse each click already toggles the zoom, so
          // the pair would toggle twice and this handler would flip it a third time.
          if (lastPointerType.current === "mouse") return;
          const at = framePoint(e, e.currentTarget);
          apply((cur, g) => tapZoomTarget(g, cur), at, at, true);
        }}
        onPointerDown={(e) => {
          // Captured so a fast drag that leaves the frame keeps feeding us moves
          // instead of stranding the image mid-pan.
          e.currentTarget.setPointerCapture(e.pointerId);
          const at = framePoint(e, e.currentTarget);
          pointers.current.set(e.pointerId, at);
          lastPointerType.current = e.pointerType;
          // Only the primary button is a click here: a right-click opens the context
          // menu and a middle-click is whatever the browser makes of it, and neither
          // should zoom the picture on release.
          tap.current =
            pointers.current.size === 1 && (e.pointerType !== "mouse" || e.button === 0)
              ? { at, x: e.clientX, y: e.clientY, type: e.pointerType }
              : null;
          gesture.current = readGesture();
          setDragging(pointers.current.size === 1);
          // Touch and pen only. On a desktop the arrows and the header buttons
          // already page, and a mouse drag that navigates is a surprise; a second
          // finger means a pinch, which outranks paging.
          swiping.current =
            onPage && !zoomed && pointers.current.size === 1 && e.pointerType !== "mouse"
              ? { x: e.clientX, y: e.clientY, at: e.timeStamp, width: e.currentTarget.clientWidth }
              : null;
          if (swiping.current) {
            setSwipeX(0);
            apply((cur) => cur, ORIGIN, ORIGIN, false);
          } else if (swipeX) setSwipeX(0);
        }}
        onPointerMove={(e) => {
          const from = gesture.current;
          if (!from || !pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, framePoint(e, e.currentTarget));
          const swiped = swiping.current;
          if (swiped) {
            // Paging, not panning: a raw finger delta, carried by the image so the
            // gesture can be seen while it happens.
            setSwipeX(e.clientX - swiped.x);
            return;
          }
          const to = readGesture();
          if (!to) return;
          // One finger has no spread, so the factor is 1 and this is a pure pan;
          // two fingers make the same call a pinch. Deltas come from the tracked
          // positions rather than `movementX/Y`, which touch and pen report as 0
          // in several browsers — panning by finger simply wouldn't move.
          const factor = from.spread > 0 && to.spread > 0 ? to.spread / from.spread : 1;
          apply((cur) => cur * factor, from.at, to.at, false);
          gesture.current = to;
        }}
        onPointerUp={endPointer}
        // A touch interrupted by the system (a call, a gesture) fires cancel, not
        // up — without this the frame would stay stuck in its grabbing state.
        onPointerCancel={endPointer}
        onKeyDown={(e) => {
          const PAN = 48;
          if (e.key === "+" || e.key === "=") step(1.4);
          else if (e.key === "-") step(1 / 1.4);
          else if (e.key === "0") apply(() => 1, ORIGIN, ORIGIN, true);
          else if (zoomed && e.key.startsWith("Arrow")) {
            // Arrows page between files (a window listener in `FilePreview`), and
            // that stays true at fit. But once the image is bigger than the frame
            // they mean panning, and with the pan now bounded a keyboard user
            // otherwise has no way to reach a corner at all. Stopping propagation
            // is what keeps the native event from also reaching that listener.
            e.stopPropagation();
            nudge(
              e.key === "ArrowLeft" ? PAN : e.key === "ArrowRight" ? -PAN : 0,
              e.key === "ArrowUp" ? PAN : e.key === "ArrowDown" ? -PAN : 0,
            );
          } else return;
          e.preventDefault();
        }}
        className={cn(
          // `touch-none`: the browser's own pan/zoom must be off for two fingers
          // to reach us as plain pointers.
          "flex h-full touch-none items-center justify-center overflow-hidden p-4 outline-none",
          // The cursor is the contract: a plus that zooms in on click, a minus that
          // zooms out on click, and a fist only while a pan is actually under way.
          zoomed ? (dragging ? "cursor-grabbing" : "cursor-zoom-out") : "cursor-zoom-in",
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={picture}
          src={img.url}
          alt={file.name}
          draggable={false}
          style={{
            transform: `translate(${view.x + swipeX}px, ${view.y}px) scale(${view.scale})`,
            // Fading as it travels turns the swap at the end of a swipe into a
            // crossfade rather than a cut, without a second image having to exist.
            // A fixed ramp rather than a fraction of the pane: this is a cosmetic
            // cue, and tying it to a measurement would put a DOM read in render.
            opacity: 1 - Math.min(0.5, Math.abs(swipeX) / SWIPE_FADE_PX),
          }}
          className={cn(
            "max-h-full max-w-full object-contain",
            // Only the discrete commands ease. A wheel, a pinch, a pan or a swipe
            // that eases behind the hand reads as lag rather than as polish — and
            // with a trackpad firing sixty events a second it reads as rubber.
            view.animate && "transition-[transform,opacity] duration-150 motion-reduce:transition-none",
          )}
        />
      </div>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-background/90 p-0.5 backdrop-blur">
        <HeaderButton onClick={() => step(1 / 1.4)} label={t("zoomOut")}><ZoomOut className="h-4 w-4" /></HeaderButton>
        <Hint label={t("zoomReset")} side="top">
          <button
            type="button"
            onClick={() => apply(() => 1, ORIGIN, ORIGIN, true)}
            className="min-w-11 rounded-md px-1.5 py-1 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            {Math.round(view.scale * 100)}%
          </button>
        </Hint>
        <HeaderButton onClick={() => step(1.4)} label={t("zoomIn")}><ZoomIn className="h-4 w-4" /></HeaderButton>
      </div>
    </div>
  );
}

// ── PDF viewer ───────────────────────────────────────────────────────────────

/**
 * PDF preview in a same-origin iframe (the browser's native viewer), but only
 * once we've confirmed the file is actually there. The download route returns an
 * error JSON for a missing file or a controller fault, and a bare iframe would
 * render that JSON as if it were the document — so we probe the status first and
 * show the same honest notice the image/text viewers use instead.
 */
function PdfViewer({ file }: { file: PreviewFile }) {
  const status = useFileStatus(file);
  if (status === "checking")
    return <ViewerLoading />;
  if (status === "ok")
    // Framed same-origin (allowed via the route's SAMEORIGIN + frame-ancestors
    // 'self'); the response CSP default-src 'none' contains the document.
    return <iframe src={inlineUrl(file)} title={file.name} className="h-full w-full border-0" />;
  return <UnavailableNotice state={status} />;
}

/** The pane while a file is being fetched. Four viewers had their own identical
 *  copy of this, which is how they drift. */
function ViewerLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
    </div>
  );
}

/**
 * Friendly full-pane notice for a file that couldn't be shown, wording the cause:
 * gone for good, briefly unavailable, too big to read in-page, or a generic error.
 *
 * Shared by every viewer. The text and HTML panes each used to inline their own
 * bare `<p>` for the same three states plus a fourth layout for "too large", so
 * one file could be reported three visually different ways depending on which
 * branch happened to catch it. `file` is only needed for the too-large case, which
 * is the one state where there is still something useful to offer.
 */
function UnavailableNotice({ state, file }: { state: "gone" | "temporary" | "error" | "too-large"; file?: PreviewFile }) {
  const t = useTranslations("chat.preview");
  const Icon = state === "temporary" ? RefreshCw : state === "too-large" ? FileWarning : ImageOff;
  const msg =
    state === "gone" ? t("gone")
    : state === "temporary" ? t("temporary")
    : state === "too-large" ? t("tooLarge")
    : t("loadError");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/30" aria-hidden />
      <p className="max-w-xs text-sm text-muted-foreground">{msg}</p>
      {state === "too-large" && file && (
        <a href={downloadUrl(file)} download={file.name} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          <Download className="h-4 w-4" />
          {t("download")}
        </a>
      )}
    </div>
  );
}

// ── HTML viewer (rendered in a sandboxed frame, with a source toggle) ──────────

function HtmlViewer({ file }: { file: PreviewFile }) {
  const t = useTranslations("chat.preview");
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const loaded = useFileText(file);

  if (loaded.state === "loading")
    return <ViewerLoading />;
  if (loaded.state !== "ok") return <UnavailableNotice state={loaded.state} file={file} />;

  return (
    <div className="flex h-full flex-col">
      {/* Rendered ⇄ source toggle — a peek at the markup without leaving Quick Look.
          ToggleGroup rather than hand-rolled pills: the app already speaks this one
          segmented-control dialect in five places (theme, language, the activity
          and usage filters, the folder-access tier), and two of them are one panel
          away from here. Base UI also reports the pressed state itself. */}
      <div className="flex shrink-0 items-center border-b bg-muted/20 px-3 py-1.5">
        <ToggleGroup
          value={[mode]}
          onValueChange={(values) => {
            if (values.length > 0) setMode(values[0] as "rendered" | "source");
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="rendered" className="h-6 px-2 text-xs">{t("rendered")}</ToggleGroupItem>
          <ToggleGroupItem value="source" className="h-6 px-2 text-xs">{t("source")}</ToggleGroupItem>
        </ToggleGroup>
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
          // No wrapping scroller: CodeViewer scrolls itself, and nesting the two
          // gave the source view two scrollbars for one document.
          <CodeViewer name={file.name} text={loaded.text} />
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

function TextViewer({ file, markdown, selectionBar }: {
  file: PreviewFile;
  markdown: boolean;
  selectionBar?: React.ReactNode;
}) {
  const loaded = useFileText(file);

  if (loaded.state === "loading")
    return <ViewerLoading />;
  if (loaded.state !== "ok") return <UnavailableNotice state={loaded.state} file={file} />;

  // `data-preview-text` is the mark the highlight-to-quote bar reads, written
  // literally the way `data-answer` is on a reply's prose — the selector that
  // pairs with it lives with the bar, in selection-actions.tsx.
  if (markdown)
    return (
      <div className="mx-auto max-w-3xl p-6" data-preview-text="">
        <Markdown>{loaded.text}</Markdown>
        {selectionBar}
      </div>
    );
  return (
    <div className="h-full" data-preview-text="">
      <CodeViewer name={file.name} text={loaded.text} />
      {selectionBar}
    </div>
  );
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
  const t = useTranslations("chat.preview");
  const [html, setHtml] = useState<string | null>(null);
  const lang = extOf(name) || "text";

  const selectAllCode = (element: HTMLDivElement) => {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const codeViewerProps = {
    tabIndex: 0,
    role: "region",
    "aria-label": t("codeViewer"),
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      // A plain div never receives keyboard events. Focus it on interaction so
      // Ctrl/Cmd+A operates on the open file, not on the page behind the dialog.
      event.currentTarget.focus({ preventScroll: true });
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAllCode(event.currentTarget);
      }
    },
  };

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

  return (
    // The copy button sits OUTSIDE the scrolling element on purpose — inside it,
    // it would scroll away from a long file, which is exactly when it's wanted.
    <div className="relative h-full">
      <CopyButton text={text} />
      {html === null ? (
        // Until Shiki arrives (or if it fails), show the raw text — never a blank pane.
        <div {...codeViewerProps} className="ql-plain h-full overflow-auto p-4 text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <pre>{text}</pre>
        </div>
      ) : (
        // Safe: this HTML is produced by Shiki, which HTML-escapes the file's text
        // before wrapping it in <span> tags — the markup is generated, not
        // user-authored (same pattern Streamdown already uses to render code in
        // chat). No raw file HTML is ever interpreted, so no sanitizer is needed.
        // eslint-disable-next-line react/no-danger -- `html` is Shiki output: Shiki HTML-escapes the file text before wrapping it in <span>s, so no raw file HTML is ever interpreted (see note above).
        <div {...codeViewerProps} className="ql-code h-full overflow-auto text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

/**
 * Copy the whole open file.
 *
 * Markdown rendered in this same overlay gives every fenced block its own copy
 * button, so a three-line snippet quoted inside a README could be copied while
 * the 400-line source file it came from could not. Ctrl/Cmd+A works, but only
 * once you know the pane takes focus first.
 */
function CopyButton({ text }: { text: string }) {
  const t = useTranslations("chat.preview");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(id);
  }, [done]);

  return (
    <Hint label={done ? t("copied") : t("copy")} side="left">
      <button
        type="button"
        onClick={() => void copyToClipboard(text).then((ok) => ok && setDone(true))}
        className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md border bg-background/90 text-muted-foreground backdrop-blur transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </Hint>
  );
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
  thumb, name, onClick, href, download, overlay, meta, className,
}: {
  thumb: React.ReactNode;
  name: string;
  onClick?: () => void;
  href?: string;
  download?: string;
  /** One short line under the name (the `+N −M` of a written file). Part of the
   *  control, so it is announced with the tile. */
  meta?: React.ReactNode;
  /** Corner action over the thumbnail (e.g. a remove button in the composer).
   *  Stays OUTSIDE the tile's own control — it is usually a button itself, and a
   *  button inside a button is invalid and unreachable by keyboard. */
  overlay?: React.ReactNode;
  /** Outer width. Defaults to the fixed square the wrapping rows want; a grid
   *  passes `w-full` so the track decides instead. */
  className?: string;
}) {
  // The filename lives INSIDE the control, which is what gives the control its
  // accessible name. It used to be a sibling <p>, and every thumbnail is either
  // `alt=""` or `aria-hidden` — so a grid of files announced as "button, button,
  // button", and a text file was worse still: its thumbnail renders the first 600
  // characters of the file, and that became the button's name. Naming it here also
  // makes the whole tile the hit target, the way Finder and Drive behave.
  const body = (
    <>
      <span className="block aspect-square w-full overflow-hidden rounded-xl bg-muted/40 ring-1 ring-border/60 transition group-hover/tile:ring-primary/40">
        {thumb}
      </span>
      {/* Two lines, not one: the assistant writes descriptive filenames, and a
          single truncated line turned `job_architect_toolkit.py` and
          `job_architecture.db` into the same unreadable stub. */}
      <span className="mt-1 line-clamp-2 break-words text-center text-[11px] leading-tight text-muted-foreground">
        {name}
      </span>
      {meta}
    </>
  );
  const control = "flex w-full flex-col rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary/50";

  return (
    <div className={cn("group/tile relative", className ?? "w-[88px] shrink-0")}>
      {href ? (
        <a href={href} download={download} title={name} className={control}>{body}</a>
      ) : onClick ? (
        <button type="button" onClick={onClick} title={name} className={cn(control, "cursor-pointer")}>{body}</button>
      ) : (
        <span className={control}>{body}</span>
      )}
      {overlay}
    </div>
  );
}

/**
 * A sandbox-backed file tile: real thumbnail, Quick Look on click (paging
 * through `viewable`), download fallback for non-previewable kinds. For files
 * addressable on the controller by chatId + path.
 */
export function SandboxFileTile({
  file, viewable, overlay, meta, verify, live, className,
}: {
  file: PreviewFile;
  /** The set to page through with ←/→. Need not contain `file` — see below. */
  viewable: PreviewFile[];
  overlay?: React.ReactNode;
  /** Forwarded to FileTile: the line under the name. */
  meta?: React.ReactNode;
  /** Forwarded to FileTile: `w-full` inside a grid, otherwise the fixed square. */
  className?: string;
  /** Probe existence and grey the tile out if the file isn't there — for the
   *  AI's referenced artifacts (a named path may never have been created). Off
   *  for user attachments, which always exist. */
  verify?: boolean;
  /** While the reply still streams, stay optimistic — don't flash "missing". */
  live?: boolean;
}) {
  const { open } = usePreview();
  const tw = useTranslations("chat.workspace");
  const status = useFileStatus(file, !!verify && !live);
  if (status === "gone") {
    // A phantom artifact: the model named this file but it isn't in the
    // workspace. Show a muted, non-clickable tile rather than a dead link.
    return (
      <span title={tw("notCreated")} className="opacity-60">
        <FileTile thumb={<MissingThumb className="h-full w-full" />} name={file.name} overlay={overlay} className={className} />
      </span>
    );
  }

  // Every file opens Quick Look, including formats with no viewer — those land on
  // the "can't show this" pane (see the Viewer dispatcher). Previously a
  // non-previewable tile was a bare `<a download>`, so clicking a .xlsx in the grid
  // started an unannounced download while the same file in the list view did
  // nothing at all.
  //
  // `viewable` may legitimately not contain this file — message.tsx builds it from
  // previewable kinds only — and findIndex would then return -1, which the provider
  // clamps to 0 and opens a DIFFERENT file than the one clicked. So fall back to a
  // set of one rather than requiring every call site to widen its list.
  const at = viewable.findIndex((v) => v.path === file.path);
  return (
    <FileTile
      thumb={<FileThumb file={file} className="h-full w-full" />}
      name={file.name}
      overlay={overlay}
      meta={meta}
      className={className}
      onClick={() => open(at >= 0 ? viewable : [file], Math.max(at, 0))}
    />
  );
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
  // Everything that is not an image: the typed sheet with its extension on a
  // badge. A .csv used to get a different tile from a .xlsx sitting next to it
  // — the csv rendered the first 600 characters of itself at 4px, which at tile
  // size is grey noise, and put a network read behind every tile in the grid to
  // fetch it. Two files whose names differ and whose contents differ looked
  // like the same smudge; the sheet at least says CSV.
  return <BinaryFileThumb name={file.name} className={className} />;
}

/** The thumbnail for a referenced file that isn't in the workspace — a muted
 *  warning glyph, so a phantom artifact reads as "not here" at a glance. */
function MissingThumb({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center bg-muted/20", className)}>
      <AlertTriangle className="h-1/3 w-1/3 text-muted-foreground/30" aria-hidden />
    </div>
  );
}

/**
 * The thumbnail for a file with no in-app preview: a folded-corner sheet tinted
 * in the file type's accent color, with the extension on a badge — the
 * macOS/Drive look. All-SVG so the same glyph stays crisp from a 36px row to an
 * 88px tile. Shared by the chat tiles, the composer, and the workspace panel.
 */
export function BinaryFileThumb({ name, className }: { name: string; className?: string }) {
  const { color, badge } = fileKind(name);
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
        {/* Extension badge. Filled from `badge`, not from the sheet's
            `currentColor`: this rect is the one place the accent carries WHITE
            text, and the accent's own step is ~3.4:1 behind white — legible
            enough for a glyph, not for a word. */}
        <rect x="3.5" y="25" width="26" height="13" rx="3" className={badge} />
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

