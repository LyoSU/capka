import { describe, it, expect } from "vitest";
import { previewKind, fileKind, extOf, splitFileName, servesAsText } from "../file-kinds";

describe("extOf", () => {
  it("lowercases the extension and drops the dot", () => {
    expect(extOf("Photo.PNG")).toBe("png");
    expect(extOf("archive.tar.gz")).toBe("gz");
  });
  it("returns empty string when there's no extension", () => {
    expect(extOf("Dockerfile")).toBe("");
  });
});

describe("previewKind", () => {
  it("treats images as image (including MIME-only formats)", () => {
    for (const n of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.avif", "a.heic"])
      expect(previewKind(n)).toBe("image");
  });

  it("treats PDFs as pdf", () => {
    expect(previewKind("report.pdf")).toBe("pdf");
  });

  it("treats markdown as markdown", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("notes.markdown")).toBe("markdown");
  });

  it("treats code and plain text as text", () => {
    for (const n of ["a.txt", "a.log", "a.json", "a.yaml", "a.toml", "a.py", "a.go", "a.rs", "a.css", "a.sh"])
      expect(previewKind(n)).toBe("text");
  });

  it("keeps dev extensions text even when MIME mislabels them (.ts → video/mp2t)", () => {
    expect(previewKind("app.ts")).toBe("text");
    expect(previewKind("App.tsx")).toBe("text");
    expect(previewKind("Component.vue")).toBe("text");
  });

  it("previews documents and decks as office (converted to PDF), case-insensitively", () => {
    for (const n of ["a.docx", "a.doc", "a.odt", "a.rtf", "deck.pptx", "deck.ppt", "deck.odp", "B.DOCX"])
      expect(previewKind(n)).toBe("office");
  });

  it("previews spreadsheets as sheet, CSV and TSV included", () => {
    for (const n of ["a.xlsx", "a.xls", "a.ods", "a.csv", "a.tsv", "A.CSV"])
      expect(previewKind(n)).toBe("sheet");
  });

  it("returns null for real binaries, video and audio", () => {
    for (const n of ["a.zip", "a.mp4", "a.mp3", "a.bin", "a.numbers"])
      expect(previewKind(n)).toBeNull();
  });
});

describe("servesAsText", () => {
  it("covers what the text viewer reads plus CSV/TSV, which a tab should still show", () => {
    for (const n of ["a.txt", "README.md", "a.ts", "a.csv", "a.tsv"]) expect(servesAsText(n)).toBe(true);
  });
  it("never covers a binary or HTML", () => {
    for (const n of ["a.xlsx", "a.docx", "a.pdf", "a.png", "page.html"]) expect(servesAsText(n)).toBe(false);
  });
});

describe("fileKind", () => {
  it("flags directories as folders", () => {
    expect(fileKind("src", true).labelKey).toBe("folder");
  });
  it("broadens icons via MIME for unlisted types", () => {
    expect(fileKind("clip.mp4").labelKey).toBe("video");
    expect(fileKind("song.mp3").labelKey).toBe("audio");
    expect(fileKind("bundle.zip").labelKey).toBe("archive");
  });
  it("falls back to the generic file label for unknown types", () => {
    // Deliberately NOT the uppercased extension any more: the chip on the
    // thumbnail and the filename itself both already show it.
    expect(fileKind("data.xyz").labelKey).toBe("file");
  });

  it("pairs every glyph accent per theme but keeps badge fills fixed", () => {
    // The two fields contrast against different things, so they follow different
    // rules — and a single-step `color` is exactly the regression that made a code
    // file's amber icon invisible on the light theme. A badge carries white text,
    // so a `dark:` variant there would be the bug instead.
    for (const name of ["a.png", "a.xlsx", "a.pdf", "a.ts", "a.mp4", "a.mp3", "a.zip", "a.xyz"]) {
      const k = fileKind(name);
      // Only a numbered palette step needs the pairing; theme tokens
      // (`text-muted-foreground`, `text-primary/70`) already adapt on their own.
      if (/-\d00\b/.test(k.color)) expect(k.color).toContain("dark:");
      expect(k.badge).not.toContain("dark:");
      expect(k.badge.startsWith("fill-")).toBe(true);
    }
  });
});

describe("splitFileName", () => {
  it("keeps the extension and the end of the stem in the tail", () => {
    expect(splitFileName("sales_for_quarter.xlsx")).toEqual({ head: "sales_for_quart", tail: "er.xlsx" });
    expect(splitFileName("memo.docx")).toEqual({ head: "me", tail: "mo.docx" });
  });
  it("loses nothing: head + tail is the name", () => {
    for (const n of ["a.pdf", "x", ".env", "Makefile", "archive.tar.gz", "weird.extension_too_long"]) {
      const { head, tail } = splitFileName(n);
      expect(head + tail).toBe(n);
    }
  });
  it("treats a dotfile or an over-long suffix as no extension", () => {
    expect(splitFileName(".bashrc")).toEqual({ head: ".ba", tail: "shrc" });
    expect(splitFileName("notes.extension_too_long").tail).toBe("long");
    expect(splitFileName("ab")).toEqual({ head: "", tail: "ab" });
  });
});
