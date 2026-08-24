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
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Download, FileWarning, ImageOff, Loader2, Maximize2, Minimize2, RefreshCw, Sparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Markdown } from "./markdown";
import { useChatDraft } from "./use-chat-draft";
import { extOf, fileKind, previewKind } from "@/lib/file-kinds";
import { fileStatusFromHttp, type FileStatus } from "@/lib/chat/file-status";
import { applyGesture, swipeVerdict, wheelZoomFactor, type Geometry, type Point } from "@/lib/chat/image-view";
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
  const { labelKey } = fileKind(file.name);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
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
          <HeaderButton onClick={() => setFullscreen((f) => !f)} label={fullscreen ? t("exitFullscreen") : t("fullscreen")}>
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </HeaderButton>
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
  label, children, onClick, href, download,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  download?: string;
}) {
  const cls =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  return href ? (
    <a href={href} download={download} aria-label={label} title={label} className={cls}>{children}</a>
  ) : (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={cls}>{children}</button>
  );
}

function Viewer({ file, kind, onClose, onPage }: {
  file: PreviewFile;
  kind: ReturnType<typeof previewKind>;
  onClose: () => void;
  /** Present only when there is more than one file to page between. */
  onPage?: (delta: number) => void;
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
    return <TextViewer file={file} markdown={kind === "markdown"} />;
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
    (next: (cur: number) => number, from: Point, to: Point, animate: boolean) => {
      setView((v) => {
        const g = geometry();
        if (!g) return v;
        const moved = applyGesture(v, g, next(v.scale), from, to);
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
          const at = framePoint(e, e.currentTarget);
          apply((cur) => (cur > 1 ? 1 : 2), at, at, true);
        }}
        onPointerDown={(e) => {
          // Captured so a fast drag that leaves the frame keeps feeding us moves
          // instead of stranding the image mid-pan.
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, framePoint(e, e.currentTarget));
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
          zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
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
        <button
          type="button"
          onClick={() => apply(() => 1, ORIGIN, ORIGIN, true)}
          aria-label={t("zoomReset")}
          title={t("zoomReset")}
          className="min-w-11 rounded-md px-1.5 py-1 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          {Math.round(view.scale * 100)}%
        </button>
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

function TextViewer({ file, markdown }: { file: PreviewFile; markdown: boolean }) {
  const loaded = useFileText(file);

  if (loaded.state === "loading")
    return <ViewerLoading />;
  if (loaded.state !== "ok") return <UnavailableNotice state={loaded.state} file={file} />;

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
    <button
      type="button"
      onClick={() => void copyToClipboard(text).then((ok) => ok && setDone(true))}
      aria-label={done ? t("copied") : t("copy")}
      title={done ? t("copied") : t("copy")}
      className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md border bg-background/90 text-muted-foreground backdrop-blur transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
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
  thumb, name, onClick, href, download, overlay, className,
}: {
  thumb: React.ReactNode;
  name: string;
  onClick?: () => void;
  href?: string;
  download?: string;
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
  file, viewable, overlay, verify, live, className,
}: {
  file: PreviewFile;
  /** The set to page through with ←/→. Need not contain `file` — see below. */
  viewable: PreviewFile[];
  overlay?: React.ReactNode;
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
  if (kind === "text" || kind === "markdown" || kind === "html") return <TextThumb file={file} className={className} />;

  // Binaries with no in-app viewer (docx, xlsx, zip…): a document glyph instead
  // of a bare icon, so a non-previewable file still reads as a real file.
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
    // aria-hidden: this is decoration. Without it the <pre> below contributes the
    // file's first 600 characters to the enclosing control's accessible name.
    <div aria-hidden className={cn("relative overflow-hidden bg-background ring-1 ring-border/60", className)}>
      {/* 4px, and wrapping on words rather than mid-character: at 3px with
          `break-all` the peek was grey noise, and two different source files were
          indistinguishable from each other in the grid. */}
      <pre className="whitespace-pre-wrap break-words p-1 font-mono text-[4px] leading-[1.35] text-foreground/70">
        {head ?? ""}
      </pre>
      {/* Fade the bottom so the clipped text reads as a peek, not a cut-off. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />
    </div>
  );
}
