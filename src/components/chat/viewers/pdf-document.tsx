"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Lock, Minus, Plus } from "lucide-react";
import { TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { openPdf } from "./pdf-load";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import styles from "./pdf-document.module.css";

/**
 * A PDF drawn by pdf.js instead of the browser's own viewer, which a phone does
 * not have: iOS Safari showed page one of an <iframe> and nothing more, Android a
 * download link. Same rendering everywhere instead — a canvas per page with the
 * text layer over it (selectable, and findable with the browser's Find on the
 * pages that are drawn), pages drawn only near the viewport and released when far
 * from it, fit to width by default.
 *
 * Loaded only when a PDF (or a converted document) is opened: pdf.js and its
 * worker are well over a megabyte and nothing else needs them.
 */

// Zoom is relative to fit-to-width, so 1 always means "the page fills the pane".
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
// Fit-to-width stops at roughly a real page at 120%: a letter page across a 2000px
// fullscreen window is a poster, not a document.
const MAX_FIT = 1.6;
// One canvas of a tall page at 2x on a wide screen is easily 20 Mpx; iOS refuses
// anything past ~16.7 Mpx, so the pixel ratio gives way first.
const MAX_CANVAS_PX = 16_000_000;
const PAD = 12;

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export default function PdfDocument({ data, selectionBar }: {
  data: ArrayBuffer;
  /** The highlight-to-quote bar, when the host has a composer to fill. */
  selectionBar?: React.ReactNode;
}) {
  const t = useTranslations("chat.preview");
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failure, setFailure] = useState<"password" | "error" | null>(null);
  // Every page's size at scale 1. Seeded from page one, corrected per page as
  // each is drawn — most documents have one page size, and asking every page up
  // front is a worker round trip per page before anything shows.
  const [sizes, setSizes] = useState<[number, number][]>([]);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [near, setNear] = useState<ReadonlySet<number>>(new Set());
  const [current, setCurrent] = useState(1);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const observer = useRef<IntersectionObserver | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    let alive = true;
    const fail = (err: unknown) => {
      if (alive) setFailure((err as { name?: string })?.name === "PasswordException" ? "password" : "error");
    };
    // Nothing in here may throw past this effect: an error from pdf.js is this
    // pane's calm failure, never the page's error boundary.
    let task: PDFDocumentLoadingTask;
    try {
      task = openPdf(data);
    } catch (err) {
      fail(err);
      return;
    }
    task.promise
      .then(async (d) => {
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        if (!alive) return;
        setSizes(Array.from({ length: d.numPages }, () => [first.width, first.height]));
        setDoc(d);
      })
      .catch(fail);
    return () => {
      alive = false;
      void task.destroy().catch(() => {});
    };
  }, [data]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  const baseWidth = sizes[0]?.[0] ?? 0;
  const fit = width && baseWidth ? Math.min(MAX_FIT, (width - PAD * 2) / baseWidth) : 0;
  const scale = fit * zoom;
  // The pages exist (and pinch has something to scale) once both are known.
  const ready = !!doc && fit > 0;

  // Pages within a screen of the viewport are drawn; the rest hold only their
  // place, so a 300-page report costs what a few pages cost.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || !doc) return;
    const io = new IntersectionObserver(
      (entries) =>
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next;
        }),
      { root, rootMargin: "100% 0px" },
    );
    for (const el of pageEls.current) if (el) io.observe(el);
    observer.current = io;
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, [doc]);

  const registerPage = useCallback((i: number, el: HTMLDivElement | null) => {
    const prev = pageEls.current[i];
    if (prev && prev !== el) observer.current?.unobserve(prev);
    pageEls.current[i] = el;
    if (el) observer.current?.observe(el);
  }, []);

  const onSize = useCallback((i: number, w: number, h: number) => {
    setSizes((s) => (s[i] && s[i][0] === w && s[i][1] === h ? s : s.map((v, j) => (j === i ? [w, h] : v))));
  }, []);

  // Zoom keeps the point under the pointer (or the pane's centre) where it was.
  const anchor = useRef<{ x: number; y: number; k: number } | null>(null);
  const zoomTo = useCallback((next: number, at?: { x: number; y: number }) => {
    const el = scrollerRef.current;
    setZoom((z) => {
      const clamped = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], next));
      if (el && clamped !== z) {
        const r = el.getBoundingClientRect();
        anchor.current = { x: at ? at.x - r.left : el.clientWidth / 2, y: at ? at.y - r.top : el.clientHeight / 2, k: clamped / z };
      }
      return clamped;
    });
  }, []);
  const step = useCallback(
    (dir: 1 | -1) =>
      setZoom((z) => {
        const next = dir > 0 ? ZOOMS.find((v) => v > z + 1e-3) : [...ZOOMS].reverse().find((v) => v < z - 1e-3);
        if (next === undefined) return z;
        const el = scrollerRef.current;
        if (el) anchor.current = { x: el.clientWidth / 2, y: el.clientHeight / 2, k: next / z };
        return next;
      }),
    [],
  );
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    el.scrollLeft = (el.scrollLeft + a.x) * a.k - a.x;
    el.scrollTop = (el.scrollTop + a.y) * a.k - a.y;
  }, [zoom]);

  // The page the reader is on: the last one whose top has passed 40% of the pane.
  const track = useRef(0);
  const onScroll = useCallback(() => {
    if (track.current) return;
    track.current = requestAnimationFrame(() => {
      track.current = 0;
      const el = scrollerRef.current;
      if (!el) return;
      const line = el.getBoundingClientRect().top + el.clientHeight * 0.4;
      let page = 1;
      pageEls.current.forEach((p, i) => {
        if (p && p.getBoundingClientRect().top <= line) page = i + 1;
      });
      setCurrent(page);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(track.current), []);

  const goToPage = useCallback((n: number) => {
    const el = scrollerRef.current;
    const p = pageEls.current[n - 1];
    if (!el || !p) return;
    el.scrollTo({ top: p.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - PAD });
  }, []);

  // PageUp/PageDown move a page; Ctrl/⌘ with +, − or 0 zooms the document rather
  // than the whole app while it is open. Nothing is taken from a text field (the
  // composer beside a docked viewer keeps its keys), and Escape is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        goToPage(Math.min(sizes.length, Math.max(1, current + (e.key === "PageDown" ? 1 : -1))));
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (e.key === "+" || e.key === "=") { e.preventDefault(); step(1); }
        else if (e.key === "-") { e.preventDefault(); step(-1); }
        else if (e.key === "0") { e.preventDefault(); zoomTo(1); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, sizes.length, goToPage, step, zoomTo]);

  // Pinch (two fingers) and trackpad pinch (a wheel event with ctrlKey) zoom the
  // document, not the page. While the fingers are down the drawn pages are only
  // scaled with a transform; the real re-render happens once, on release. The
  // pane's `touch-action: pan-x pan-y` keeps the browser's own page zoom out of it.
  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content || !ready) return;
    let start: { d: number; x: number; y: number } | null = null;
    let ratio = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const r = el.getBoundingClientRect();
      const x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      start = { d: dist(e.touches), x, y };
      ratio = 1;
      content.style.transformOrigin = `${x - r.left + el.scrollLeft - content.offsetLeft}px ${y - r.top + el.scrollTop - content.offsetTop}px`;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      e.stopPropagation();
      ratio = dist(e.touches) / start.d;
      content.style.transform = `scale(${ratio})`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || e.touches.length >= 2) return;
      content.style.transform = "";
      if (Math.abs(ratio - 1) > 0.02) zoomTo(zoomRef.current * ratio, { x: start.x, y: start.y });
      start = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY / 200), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, [ready, zoomTo]);

  if (failure)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        {failure === "password" && <Lock className="h-8 w-8 text-muted-foreground/30" aria-hidden />}
        <p className="max-w-xs text-sm text-muted-foreground">{failure === "password" ? t("pdfPassword") : t("loadError")}</p>
      </div>
    );

  const total = sizes.length;
  const btn =
    "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b bg-muted/20 px-3 py-1">
        <span className="min-w-0 flex-1 text-xs tabular-nums text-muted-foreground">
          {total > 0 && <span aria-label={t("pdfPage", { current, total })}>{current} / {total}</span>}
        </span>
        <Hint label={t("zoomOut")} side="bottom">
          <button type="button" className={btn} onClick={() => step(-1)} disabled={!doc || zoom <= ZOOMS[0]}>
            <Minus className="h-4 w-4" />
          </button>
        </Hint>
        <Hint label={t("zoomFit")} side="bottom">
          <button
            type="button"
            onClick={() => zoomTo(1)}
            disabled={!doc}
            className="h-7 min-w-12 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {Math.round(zoom * 100)}%
          </button>
        </Hint>
        <Hint label={t("zoomIn")} side="bottom">
          <button type="button" className={btn} onClick={() => step(1)} disabled={!doc || zoom >= ZOOMS[ZOOMS.length - 1]}>
            <Plus className="h-4 w-4" />
          </button>
        </Hint>
      </div>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        tabIndex={0}
        aria-label={t("pdfDocument")}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-muted/40 outline-none [touch-action:pan-x_pan-y]"
      >
        {!doc || !scale ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40 motion-reduce:animate-none" />
          </div>
        ) : (
          <div ref={contentRef} className="mx-auto flex w-max min-w-full flex-col items-center" style={{ gap: PAD, padding: PAD }} data-preview-text="">
            {sizes.map(([w, h], i) => (
              <PdfPage
                key={i}
                doc={doc}
                index={i}
                scale={scale}
                width={w}
                height={h}
                near={near.has(i)}
                register={registerPage}
                onSize={onSize}
              />
            ))}
          </div>
        )}
        {selectionBar}
      </div>
    </div>
  );
}

function PdfPage({ doc, index, scale, width, height, near, register, onSize }: {
  doc: PDFDocumentProxy;
  index: number;
  scale: number;
  width: number;
  height: number;
  near: boolean;
  register: (i: number, el: HTMLDivElement | null) => void;
  onSize: (i: number, w: number, h: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const layer = useRef<{ text: TextLayer; scale: number } | null>(null);
  const [drawn, setDrawn] = useState(false);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const setBox = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el;
    register(index, el);
  }, [index, register]);

  // The canvas. A zoom draws a NEW canvas and swaps it in when done, so the old
  // one (stretched by CSS meanwhile) stays up instead of the page going blank.
  useEffect(() => {
    if (!near) return;
    let gone = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await doc.getPage(index + 1);
      if (gone) return;
      const own = page.getViewport({ scale: 1 });
      onSize(index, own.width, own.height);
      const vp = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PX / (vp.width * vp.height)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * ratio);
      canvas.height = Math.floor(vp.height * ratio);
      canvas.className = "absolute inset-0 h-full w-full";
      task = page.render({ canvas, viewport: vp, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await task.promise;
      const host = hostRef.current;
      if (gone || !host) {
        canvas.width = 0;
        return;
      }
      for (const old of host.querySelectorAll("canvas")) old.width = 0;
      host.replaceChildren(canvas);
      setDrawn(true);
    })().catch(() => {}); // a cancelled render (scrolled away, zoomed again) is not an error
    return () => {
      gone = true;
      task?.cancel();
    };
  }, [doc, index, scale, near, onSize]);

  // The text layer: built once per visit, then re-laid out on zoom. Its spans are
  // positioned in percentages and sized from --total-scale-factor, so it follows
  // the page box even before update() runs.
  useEffect(() => {
    const el = textRef.current;
    if (!near || !el) return;
    let gone = false;
    (async () => {
      const page = await doc.getPage(index + 1);
      if (gone) return;
      const text = new TextLayer({ textContentSource: page.streamTextContent(), container: el, viewport: page.getViewport({ scale: scaleRef.current }) });
      layer.current = { text, scale: scaleRef.current };
      await text.render();
    })().catch(() => {});
    return () => {
      gone = true;
      layer.current?.text.cancel();
      layer.current = null;
      el.replaceChildren();
    };
  }, [doc, index, near]);
  useEffect(() => {
    const l = layer.current;
    if (!l || l.scale === scale) return;
    l.scale = scale;
    void doc.getPage(index + 1).then((page) => {
      if (layer.current === l) l.text.update({ viewport: page.getViewport({ scale }) });
    });
  }, [doc, index, scale]);

  // Far from the viewport: give the canvas memory back.
  useEffect(() => {
    if (near) return;
    const host = hostRef.current;
    if (!host) return;
    for (const c of host.querySelectorAll("canvas")) c.width = 0;
    host.replaceChildren();
    setDrawn(false);
  }, [near]);

  return (
    <div
      ref={setBox}
      data-page={index}
      className={cn(styles.page, "relative shrink-0 bg-white shadow-sm ring-1 ring-black/5 dark:brightness-[.92]", !drawn && "animate-pulse motion-reduce:animate-none")}
      style={{ width: Math.floor(width * scale), height: Math.floor(height * scale), "--total-scale-factor": scale } as React.CSSProperties}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}
