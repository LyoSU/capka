import { read, utils, type CellObject, type WorkSheet } from "xlsx";

/**
 * A spreadsheet reduced to what the in-app table draws: formatted text per cell,
 * merges as spans, column widths in pixels. Built in a Web Worker from a file the
 * user (or the agent) put in the workspace, so it is plain data — structured-clone
 * safe — and capped: a preview is for looking, Download is for working.
 */
export const MAX_SHEET_ROWS = 5000;
export const MAX_SHEET_COLS = 200;
const DEFAULT_COL_PX = 72;

/** A plain string for an ordinary cell; an object only where there is more to say
 *  (a number to right-align, a merge origin). `null` is a cell a merge covers. */
export type SheetCell = string | { v: string; num?: true; rs?: number; cs?: number } | null;

export type SheetModel = {
  name: string;
  rows: SheetCell[][];
  /** Pixel width per shown column. Its length is the shown column count. */
  widths: number[];
  /** Merge origins as [row, rowSpan], for windowing: a merged block whose origin
   *  scrolled above the window still has to be drawn from that origin. */
  tall: [number, number][];
  /** The sheet's real size, so a cap can say what it left out. */
  totalRows: number;
  totalCols: number;
};

// A CSV keeps its cells as written ("01" stays "01"), so numbers are recognised by
// shape for alignment only — never converted.
const NUMERIC = /^[-+]?[\d\s .,]*\d%?$/;

/** CSV/TSV bytes as text. UTF-8 first; a file that is not valid UTF-8 is far more
 *  likely an Excel export in the Windows Cyrillic code page than anything else this
 *  audience produces, so that is the one fallback. */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

export function parseSheetFile(bytes: Uint8Array, ext: string): SheetModel[] {
  const delimited = ext === "csv" || ext === "tsv";
  const wb = delimited
    // `raw`: a CSV cell is shown as written, not re-read as a date or a number.
    ? read(decodeText(bytes), { type: "string", raw: true, dense: true, sheetRows: MAX_SHEET_ROWS })
    // `cellStyles` is what makes SheetJS read column widths; formulas and HTML are
    // never shown, so they are not parsed.
    : read(bytes, { type: "array", dense: true, sheetRows: MAX_SHEET_ROWS, cellStyles: true, cellFormula: false, cellHTML: false });
  return wb.SheetNames.map((name) => sheetModel(name, wb.Sheets[name], delimited));
}

export function sheetModel(name: string, ws: WorkSheet, delimited = false): SheetModel {
  const ref = ws["!ref"];
  if (!ref) return { name, rows: [], widths: [], tall: [], totalRows: 0, totalCols: 0 };
  const range = utils.decode_range(ref);
  // `sheetRows` trims `!ref` to what was read and keeps the real size here.
  const full = utils.decode_range((ws["!fullref"] as string | undefined) ?? ref);
  const totalRows = full.e.r + 1;
  const totalCols = full.e.c + 1;
  // From A1, as a spreadsheet app shows it, so row numbers and letters stay true.
  const nRows = Math.min(range.e.r + 1, MAX_SHEET_ROWS);
  const nCols = Math.min(range.e.c + 1, MAX_SHEET_COLS);
  const data = (ws["!data"] ?? []) as (CellObject | undefined)[][];

  const rows: SheetCell[][] = [];
  for (let r = 0; r < nRows; r++) {
    const src = data[r] ?? [];
    const row: SheetCell[] = new Array(nCols);
    for (let c = 0; c < nCols; c++) {
      const cell = src[c];
      const v = cell ? (cell.w ?? (cell.v == null ? "" : String(cell.v))) : "";
      const num = cell?.t === "n" || (delimited && v !== "" && NUMERIC.test(v));
      row[c] = num ? { v, num: true } : v;
    }
    rows.push(row);
  }

  const tall: [number, number][] = [];
  for (const m of ws["!merges"] ?? []) {
    const { r, c } = m.s;
    if (r >= nRows || c >= nCols) continue;
    const rs = Math.min(m.e.r, nRows - 1) - r + 1;
    const cs = Math.min(m.e.c, nCols - 1) - c + 1;
    if (rs < 1 || cs < 1 || (rs === 1 && cs === 1)) continue;
    for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) rows[rr][cc] = null;
    const origin = data[r]?.[c];
    const v = origin ? (origin.w ?? (origin.v == null ? "" : String(origin.v))) : "";
    rows[r][c] = { v, rs, cs, ...(origin?.t === "n" ? { num: true as const } : {}) };
    if (rs > 1) tall.push([r, rs]);
  }

  const cols = ws["!cols"] ?? [];
  const widths = Array.from({ length: nCols }, (_, c) => {
    const col = cols[c];
    const px = col?.wpx ?? (col?.wch != null ? col.wch * 7 + 5 : DEFAULT_COL_PX);
    return Math.round(Math.min(480, Math.max(32, px)));
  });

  return { name, rows, widths, tall, totalRows, totalCols };
}
