"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Loader2 } from "lucide-react";
import type { SheetCell, SheetModel } from "@/lib/sheet-model";
import { cn } from "@/lib/utils";

/**
 * A spreadsheet as a read-only table: sheet tabs, sticky column letters and row
 * numbers, merged cells, the file's own column widths, values as the file formats
 * them. Parsed by SheetJS in a worker (see sheet.worker.ts), so the parser and its
 * half-megabyte stay out of every bundle that does not open a spreadsheet.
 *
 * Rows are windowed by hand rather than with a virtualizer library: every row is
 * one fixed height (cells do not wrap), which reduces windowing to two divisions
 * and a spacer row above and below — the only wrinkle, a merged block whose
 * origin scrolled out of the window, is handled by starting the window there.
 */

const ROW_H = 24;
const OVERSCAN = 12;
// A parse that is still running after this is a file too big (or too hostile) to
// preview; the worker is terminated and Download offered instead.
const PARSE_TIMEOUT_MS = 20_000;

type Parsed = { state: "loading" } | { state: "ok"; sheets: SheetModel[] } | { state: "error" | "slow" };

function colLetter(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export default function SheetTable({ data, ext, downloadHref, fileName, selectionBar }: {
  data: ArrayBuffer;
  ext: string;
  downloadHref: string;
  fileName: string;
  selectionBar?: React.ReactNode;
}) {
  const t = useTranslations("chat.preview");
  const [parsed, setParsed] = useState<Parsed>({ state: "loading" });
  const [active, setActive] = useState(0);

  useEffect(() => {
    const worker = new Worker(new URL("./sheet.worker.ts", import.meta.url), { type: "module" });
    const done = (p: Parsed) => {
      clearTimeout(timer);
      worker.terminate();
      setParsed(p);
    };
    const timer = setTimeout(() => done({ state: "slow" }), PARSE_TIMEOUT_MS);
    worker.onmessage = (e: MessageEvent<{ ok: boolean; sheets?: SheetModel[] }>) =>
      done(e.data.ok && e.data.sheets ? { state: "ok", sheets: e.data.sheets } : { state: "error" });
    worker.onerror = () => done({ state: "error" });
    const copy = data.slice(0);
    worker.postMessage({ bytes: copy, ext }, [copy]);
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [data, ext]);

  const download = (
    <a href={downloadHref} download={fileName} className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline">
      <Download className="h-3.5 w-3.5" aria-hidden />
      {t("download")}
    </a>
  );

  if (parsed.state === "loading")
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40 motion-reduce:animate-none" />
      </div>
    );
  if (parsed.state !== "ok")
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-xs text-sm text-muted-foreground">{parsed.state === "slow" ? t("sheetTooBig") : t("sheetError")}</p>
        <p className="text-sm">{download}</p>
      </div>
    );

  const sheets = parsed.sheets;
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const cutRows = sheet.totalRows > sheet.rows.length;
  const cutCols = sheet.totalCols > sheet.widths.length;

  return (
    <div className="flex h-full flex-col">
      {(cutRows || cutCols) && (
        <p className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            {cutRows && t("sheetCutRows", { shown: sheet.rows.length, total: sheet.totalRows })}
            {cutRows && cutCols && " "}
            {cutCols && t("sheetCutCols", { shown: sheet.widths.length, total: sheet.totalCols })}
          </span>
          {download}
        </p>
      )}
      {/* Keyed by sheet: a tab switch starts at the top-left of the new sheet. */}
      <Grid key={active} sheet={sheet} emptyLabel={t("sheetEmpty")} selectionBar={selectionBar} />
      {sheets.length > 1 && (
        <div role="tablist" aria-label={t("sheetTabs")} className="flex shrink-0 gap-0.5 overflow-x-auto border-t bg-muted/20 px-2 py-1">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                i === active ? "bg-card font-medium text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-hover hover:text-foreground",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Grid({ sheet, emptyLabel, selectionBar }: { sheet: SheetModel; emptyLabel: string; selectionBar?: React.ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const n = sheet.rows.length;
  const numW = 16 + 8 * String(n).length;
  const tableW = numW + sheet.widths.reduce((a, b) => a + b, 0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollerRef.current;
      if (el) setView({ top: el.scrollTop, height: el.clientHeight });
    });
  };

  let start = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const end = Math.min(n, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);
  for (const [r, rs] of sheet.tall) if (r < start && r + rs > start) start = r;

  const head = useMemo(
    () =>
      sheet.widths.map((_, c) => (
        <th key={c} scope="col" className="sticky top-0 z-[2] h-6 select-none border-b border-r border-border bg-muted px-1 text-center text-[11px] font-normal text-muted-foreground">
          {colLetter(c)}
        </th>
      )),
    [sheet.widths],
  );

  if (n === 0) return <p className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{emptyLabel}</p>;

  const cell = (v: SheetCell, r: number, c: number) => {
    if (v === null) return null;
    const o = typeof v === "string" ? { v } : v;
    return (
      <td
        key={c}
        colSpan={o.cs}
        rowSpan={o.rs ? Math.min(o.rs, end - r) : undefined}
        title={o.v.length > 24 ? o.v : undefined}
        className={cn(
          "overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-border/60 bg-card px-1.5",
          o.num && "text-right tabular-nums",
          o.rs && o.rs > 1 && "align-top",
        )}
      >
        {o.v}
      </td>
    );
  };

  return (
    <div ref={scrollerRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto overscroll-contain" data-preview-text="">
      <table className="table-fixed border-separate border-spacing-0 text-xs" style={{ width: tableW }}>
        <colgroup>
          <col style={{ width: numW }} />
          {sheet.widths.map((w, c) => <col key={c} style={{ width: w }} />)}
        </colgroup>
        <thead>
          <tr>
            <th aria-hidden className="sticky left-0 top-0 z-[3] h-6 border-b border-r border-border bg-muted" />
            {head}
          </tr>
        </thead>
        <tbody>
          {start > 0 && <tr aria-hidden style={{ height: start * ROW_H }}><td colSpan={sheet.widths.length + 1} /></tr>}
          {sheet.rows.slice(start, end).map((row, i) => {
            const r = start + i;
            return (
              <tr key={r} style={{ height: ROW_H }}>
                <th scope="row" className="sticky left-0 z-[1] select-none border-b border-r border-border bg-muted px-1 text-right text-[11px] font-normal tabular-nums text-muted-foreground">
                  {r + 1}
                </th>
                {row.map((v, c) => cell(v, r, c))}
              </tr>
            );
          })}
          {end < n && <tr aria-hidden style={{ height: (n - end) * ROW_H }}><td colSpan={sheet.widths.length + 1} /></tr>}
        </tbody>
      </table>
      {selectionBar}
    </div>
  );
}
