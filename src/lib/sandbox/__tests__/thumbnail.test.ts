import { describe, it, expect } from "vitest";
import { PDF_CHUNK_BYTES, PDF_CHUNK_SCRIPT, THUMBNAIL_SCRIPT, thumbnailKey, workspaceRelative } from "@/lib/sandbox/thumbnail";
import { thumbnailable } from "@/lib/file-kinds";

describe("thumbnailable", () => {
  it("covers office documents and PDFs, case-insensitively, and nothing else", () => {
    for (const n of ["a.docx", "B.PDF", "deck.pptx", "t.xlsx", "x.odt", "old.doc", "s.ods"]) expect(thumbnailable(n)).toBe(true);
    for (const n of ["a.csv", "pic.png", "notes.md", "docx", "archive.zip"]) expect(thumbnailable(n)).toBe(false);
  });
});

describe("workspaceRelative", () => {
  it("accepts workspace paths in the shapes the UI holds them", () => {
    expect(workspaceRelative("report.docx")).toBe("report.docx");
    expect(workspaceRelative("./out/report.docx")).toBe("out/report.docx");
    expect(workspaceRelative("/workspace/out/report.docx")).toBe("out/report.docx");
  });

  it("refuses anything that leaves the workspace or is malformed", () => {
    for (const p of ["", "/etc/passwd", "../x.pdf", "out/../../x.pdf", "out//x.pdf", "/workspace/../x.pdf"]) {
      expect(workspaceRelative(p)).toBeNull();
    }
  });
});

describe("thumbnailKey", () => {
  it("changes with the file version and the workspace, and is safe in a filename", () => {
    const k = thumbnailKey("chat1", "a.docx", "2026-10-01T10:00:00.000Z", 100);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(thumbnailKey("chat1", "a.docx", "2026-10-01T10:00:00.000Z", 100)).toBe(k);
    expect(thumbnailKey("chat1", "a.docx", "2026-10-01T10:00:01.000Z", 100)).not.toBe(k);
    expect(thumbnailKey("chat1", "a.docx", "2026-10-01T10:00:00.000Z", 101)).not.toBe(k);
    expect(thumbnailKey("chat2", "a.docx", "2026-10-01T10:00:00.000Z", 100)).not.toBe(k);
  });
});

describe("THUMBNAIL_SCRIPT", () => {
  it("takes the path only from the environment and keeps its cache out of the workspace", () => {
    expect(THUMBNAIL_SCRIPT).toContain('realpath -e -- "$CAPKA_THUMB_PATH"');
    expect(THUMBNAIL_SCRIPT).toContain("d=/tmp/.capka-thumbs");
    expect(THUMBNAIL_SCRIPT).not.toMatch(/\$\{(?!\w)/); // no stray template interpolation residue
  });
});

describe("kept PDF for the document preview", () => {
  it("keeps the converted PDF only for documents and decks, never for sheets", () => {
    expect(THUMBNAIL_SCRIPT).toContain('pdf="$d/$CAPKA_THUMB_KEY.pdf"');
    expect(THUMBNAIL_SCRIPT).toMatch(/docx\|doc\|odt\|rtf\|pptx\|ppt\|odp\)\n\s+cp -- "\$w\/in\.pdf"/);
    // The format comes from the environment and is optional, so the tile route
    // (which never sets it) keeps getting its PNG.
    expect(THUMBNAIL_SCRIPT).toContain("printenv CAPKA_THUMB_FORMAT || :");
  });

  it("reads a slice that fits the controller's 1 MB exec output as base64", () => {
    expect(Math.ceil(PDF_CHUNK_BYTES / 3) * 4).toBeLessThan(1_000_000);
    expect(PDF_CHUNK_SCRIPT).toContain('f="/tmp/.capka-thumbs/$CAPKA_THUMB_KEY.pdf"');
    expect(PDF_CHUNK_SCRIPT).toContain(`bs=${PDF_CHUNK_BYTES} skip="$CAPKA_PDF_CHUNK"`);
  });
});
