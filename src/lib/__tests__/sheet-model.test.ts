import { describe, it, expect } from "vitest";
import { utils, write } from "xlsx";
import { MAX_SHEET_COLS, MAX_SHEET_ROWS, parseSheetFile } from "../sheet-model";

/** A workbook built here, written to real xlsx bytes and read back through the
 *  same path the viewer's worker takes. */
function xlsx(sheets: Record<string, ReturnType<typeof utils.aoa_to_sheet>>): Uint8Array {
  const wb = utils.book_new();
  for (const [name, ws] of Object.entries(sheets)) utils.book_append_sheet(wb, ws, name);
  return new Uint8Array(write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

describe("parseSheetFile", () => {
  it("keeps every sheet, formatted values, merges and column widths", () => {
    const ws = utils.aoa_to_sheet([
      ["Quarterly report", null, null],
      ["Item", "Qty", "Price"],
      ["Pens", 12, 1.5],
    ]);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
    ws["!cols"] = [{ wpx: 150 }, { wch: 10 }];
    ws["C3"].z = "0.00";
    const [first, second] = parseSheetFile(xlsx({ Summary: ws, Empty: utils.aoa_to_sheet([]) }), "xlsx");

    expect(first.name).toBe("Summary");
    // The merge origin spans the block; the cells it covers are null.
    expect(first.rows[0]).toEqual([{ v: "Quarterly report", rs: 1, cs: 3 }, null, null]);
    expect(first.rows[1]).toEqual(["Item", "Qty", "Price"]);
    // Numbers as the file formats them, flagged for right alignment.
    expect(first.rows[2]).toEqual(["Pens", { v: "12", num: true }, { v: "1.50", num: true }]);
    expect(first.widths).toEqual([150, 65, 72]); // wch is turned into pixels by SheetJS itself
    expect(first.tall).toEqual([]);
    expect([first.totalRows, first.totalCols]).toEqual([3, 3]);

    expect(second).toMatchObject({ name: "Empty", rows: [], widths: [] });
  });

  it("records a tall merge so a window that starts inside it can start at its origin", () => {
    const ws = utils.aoa_to_sheet([["Group", "a"], [null, "b"], [null, "c"]]);
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 2, c: 0 } }];
    const [s] = parseSheetFile(xlsx({ S: ws }), "xlsx");
    expect(s.rows.map((r) => r[0])).toEqual([{ v: "Group", rs: 3, cs: 1 }, null, null]);
    expect(s.tall).toEqual([[0, 3]]);
  });

  it("caps rows and columns and says how big the sheet really is", () => {
    const rows = MAX_SHEET_ROWS + 50;
    const ws = utils.aoa_to_sheet(Array.from({ length: rows }, (_, r) => [`r${r}`]));
    utils.sheet_add_aoa(ws, [["far"]], { origin: { r: 0, c: MAX_SHEET_COLS + 9 } });
    // A merge running past the cap is cut at it, not dropped.
    ws["!merges"] = [{ s: { r: MAX_SHEET_ROWS - 1, c: 0 }, e: { r: MAX_SHEET_ROWS + 10, c: 0 } }];
    const [s] = parseSheetFile(xlsx({ Big: ws }), "xlsx");
    expect(s.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(s.widths).toHaveLength(MAX_SHEET_COLS);
    expect(s.totalRows).toBe(rows);
    expect(s.totalCols).toBe(MAX_SHEET_COLS + 10);
    expect(s.rows[MAX_SHEET_ROWS - 1][0]).toBe(`r${MAX_SHEET_ROWS - 1}`); // a 1x1 remainder is a plain cell
    expect(s.tall).toEqual([]);
  });

  it("shows CSV cells as written, aligning numbers by shape only", () => {
    const csv = new TextEncoder().encode("﻿id,date,amount\n01,1/2/2023,\"1,5\"\n");
    const [s] = parseSheetFile(csv, "csv");
    expect(s.rows[1]).toEqual([{ v: "01", num: true }, "1/2/2023", { v: "1,5", num: true }]);
    expect(s.rows[0][0]).toBe("id"); // the BOM is not part of the first header
  });

  it("reads TSV, and a CSV in the Windows Cyrillic code page", () => {
    const [tsv] = parseSheetFile(new TextEncoder().encode("a\tb\n1\t2\n"), "tsv");
    expect(tsv.rows[0]).toEqual(["a", "b"]);
    // A Ukrainian word in windows-1251: not valid UTF-8, so the fallback decodes it.
    const cp1251 = new Uint8Array([0xcd, 0xe0, 0xe7, 0xe2, 0xe0, 0x2c, 0x78, 0x0a]);
    expect(parseSheetFile(cp1251, "csv")[0].rows[0]).toEqual([String.fromCharCode(0x41d, 0x430, 0x437, 0x432, 0x430), "x"]);
  });
});
