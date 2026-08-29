import { describe, it, expect } from "vitest";
import { safeFilename, contentDisposition, archiveFilename } from "../download-filename";

describe("safeFilename", () => {
  it("keeps a plain name untouched", () => {
    expect(safeFilename("Quarterly report", "Workspace")).toBe("Quarterly report");
  });

  it("keeps Cyrillic and emoji — they are valid on Windows, macOS and Linux", () => {
    expect(safeFilename("Quarterly report", "Workspace")).toBe("Quarterly report");
    expect(safeFilename("Report 📊", "Workspace")).toBe("Report 📊");
  });

  it("replaces the characters Windows forbids", () => {
    // < > : " / \ | ? * — every one of these makes the file unsaveable on Windows,
    // and `/` would silently split the name into a path on every OS.
    expect(safeFilename('Q4: report/draft', "Workspace")).toBe("Q4- report-draft");
    expect(safeFilename('a<b>c"d|e?f*g\\h', "Workspace")).toBe("a-b-c-d-e-f-g-h");
  });

  it("strips control characters", () => {
    expect(safeFilename("report\x00\x1f\x7fdraft", "Workspace")).toBe("reportdraft");
    expect(safeFilename("line\nbreak\ttab", "Workspace")).toBe("line break tab");
  });

  it("renames Windows reserved device names", () => {
    // Case-insensitive.
    expect(safeFilename("CON", "Workspace")).toBe("CON-");
    expect(safeFilename("nul", "Workspace")).toBe("nul-");
    expect(safeFilename("COM1", "Workspace")).toBe("COM1-");
    expect(safeFilename("LPT9", "Workspace")).toBe("LPT9-");
    // Not reserved: only the exact device names are.
    expect(safeFilename("CONTRACT", "Workspace")).toBe("CONTRACT");
    expect(safeFilename("COM10", "Workspace")).toBe("COM10");
  });

  it("renames a reserved device name that carries an extension", () => {
    // Windows resolves the device from the name BEFORE the first dot, so `NUL.txt`
    // is as unsaveable as `NUL` — and so is anything we then append, which is how
    // a chat titled `NUL.txt` would produce an undownloadable `NUL.txt — DATE.zip`.
    expect(safeFilename("NUL.txt", "Workspace")).toBe("NUL-.txt");
    expect(safeFilename("nul.tar.gz", "Workspace")).toBe("nul-.tar.gz");
    expect(safeFilename("CON.report.md", "Workspace")).toBe("CON-.report.md");
    // A reserved word only as a LATER component is fine.
    expect(safeFilename("report.nul", "Workspace")).toBe("report.nul");
  });

  it("renames the superscript device names Windows also reserves", () => {
    // COM¹/COM²/COM³ and LPT¹-³ are reserved alongside their ASCII spellings.
    expect(safeFilename("COM¹", "Workspace")).toBe("COM¹-");
    expect(safeFilename("LPT³", "Workspace")).toBe("LPT³-");
  });

  it("drops trailing dots and spaces that Windows silently truncates", () => {
    expect(safeFilename("report...", "Workspace")).toBe("report");
    expect(safeFilename("report   ", "Workspace")).toBe("report");
    expect(safeFilename("report. . ", "Workspace")).toBe("report");
  });

  it("drops leading dots so the archive is not hidden on macOS and Linux", () => {
    expect(safeFilename(".report", "Workspace")).toBe("report");
    expect(safeFilename("...report", "Workspace")).toBe("report");
  });

  it("drops a leading dash, which reads as a flag to command-line tools", () => {
    expect(safeFilename("-rf report", "Workspace")).toBe("rf report");
  });

  it("collapses whitespace runs instead of leaving a ragged name", () => {
    expect(safeFilename("Q4    report", "Workspace")).toBe("Q4 report");
  });

  it("truncates long names with room to spare under the 255-byte filesystem limit", () => {
    // A Japanese kana is 3 bytes in UTF-8 and filesystem limits are byte-based,
    // so the cap has to be measured in bytes, not characters.
    const long = "ま".repeat(200);
    const out = safeFilename(long, "Workspace");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(120);
    expect(out.startsWith("ま")).toBe(true);
  });

  it("never truncates in the middle of a multi-byte character", () => {
    const out = safeFilename("ま".repeat(200), "Workspace");
    // A split surrogate/continuation byte would decode to U+FFFD.
    expect(out).not.toContain("�");
    expect(Buffer.byteLength(out, "utf8") % 3).toBe(0);
  });

  it("falls back when nothing usable survives", () => {
    expect(safeFilename("", "Workspace")).toBe("Workspace");
    expect(safeFilename("   ", "Workspace")).toBe("Workspace");
    expect(safeFilename("///", "Workspace")).toBe("Workspace");
    expect(safeFilename("...", "Workspace")).toBe("Workspace");
    expect(safeFilename(null, "Workspace")).toBe("Workspace");
    expect(safeFilename(undefined, "Workspace")).toBe("Workspace");
  });

  it("never yields a relative-path name", () => {
    expect(safeFilename("..", "Workspace")).toBe("Workspace");
    expect(safeFilename(".", "Workspace")).toBe("Workspace");
  });

  it("sanitizes the fallback too, so a bad caller cannot inject one", () => {
    expect(safeFilename("", 'bad/name"')).toBe("bad-name-");
  });
});

describe("contentDisposition", () => {
  it("emits both an ASCII filename and a UTF-8 one", () => {
    const header = contentDisposition("Quarterly report — 2026-08-22.zip");
    expect(header).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    // The UTF-8 form carries the real name.
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("Quarterly report — 2026-08-22.zip")}`);
  });

  it("transliterates the dash separator instead of mangling it in the ASCII fallback", () => {
    const header = contentDisposition("Report — 2026-08-22.zip");
    expect(header).toContain('filename="Report - 2026-08-22.zip"');
  });

  it("keeps the ASCII fallback pure ASCII and quote-free", () => {
    const header = contentDisposition('Report "important" — 2026-08-22.zip');
    const ascii = header.match(/filename="([^"]*)"/)![1];
    expect(ascii).toMatch(/^[\x20-\x7E]*$/);
    expect(ascii).not.toContain('"');
    // A CR/LF reaching the header would be response splitting.
    expect(header).not.toMatch(/[\r\n]/);
  });

  it("percent-encodes the apostrophe, which is the filename* delimiter itself", () => {
    // `filename*=UTF-8''<value>` uses `'` as its own separator, so a raw apostrophe
    // in the value can truncate the name at the parser. Apostrophes are ordinary in
    // names (L'été, O'Brien), so this is the common case, not an edge one.
    const header = contentDisposition("L'été.zip");
    const ext = header.match(/filename\*=UTF-8''(.*)$/)![1];
    expect(ext).not.toContain("'");
    expect(ext).toContain("%27");
  });

  it("percent-encodes every character RFC 8187 does not allow raw", () => {
    // encodeURIComponent leaves ! ~ * ' ( ) alone, but RFC 8187's attr-char permits
    // only ALPHA / DIGIT / ! # $ & + - . ^ _ ` | ~ — a browser is free to ignore a
    // malformed filename* and fall back to the mangled ASCII name.
    const header = contentDisposition("O'Reilly (1)*.zip");
    const ext = header.match(/filename\*=UTF-8''(.*)$/)![1];
    expect(ext).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]*$/);
  });

  it("round-trips the real name through the filename* encoding", () => {
    const name = "Quarterly report — 2026-08-22.zip";
    const ext = contentDisposition(name).match(/filename\*=UTF-8''(.*)$/)![1];
    expect(decodeURIComponent(ext)).toBe(name);
  });

  it("serves an inline disposition when asked, for previewable files", () => {
    expect(contentDisposition("photo.png", "inline")).toMatch(/^inline; filename="photo\.png"/);
    expect(contentDisposition("photo.png")).toMatch(/^attachment; /);
  });

  it("neutralizes a quote in the name, which would otherwise end the quoted string early", () => {
    // A workspace file the agent named `a".zip` must not be able to break out of
    // filename="..." and inject header syntax.
    const ascii = contentDisposition('a".zip').match(/filename="([^"]*)"/)![1];
    expect(ascii).not.toContain('"');
    expect(contentDisposition('a".zip')).not.toMatch(/[\r\n]/);
  });

  it("never lets an ASCII fallback collapse to nothing", () => {
    const header = contentDisposition("Quarterly.zip");
    const ascii = header.match(/filename="([^"]*)"/)![1];
    expect(ascii.replace(/[_\s]/g, "")).not.toBe("");
  });
});

describe("archiveFilename", () => {
  const day = new Date("2026-08-22T10:30:00Z");

  it("names the archive after what is inside it, dated", () => {
    expect(archiveFilename("Quarterly report", "Workspace", "zip", day)).toBe(
      "Quarterly report — 2026-08-22.zip",
    );
  });

  it("dates in UTC so the same workspace never yields two spellings of one day", () => {
    // 23:30 UTC is already "tomorrow" in Kyiv; the server has no client timezone
    // on a plain <a href> download, so UTC is the one stable answer.
    expect(archiveFilename("Report", "Workspace", "zip", new Date("2026-08-22T23:30:00Z"))).toBe(
      "Report — 2026-08-22.zip",
    );
  });

  it("sanitizes the label", () => {
    expect(archiveFilename("Q4: plan/v2", "Workspace", "zip", day)).toBe("Q4- plan-v2 — 2026-08-22.zip");
  });

  it("falls back when the chat has no title", () => {
    expect(archiveFilename(null, "Workspace", "zip", day)).toBe("Workspace — 2026-08-22.zip");
  });

  it("carries the extension it is given", () => {
    expect(archiveFilename("Report", "Workspace", "tar.gz", day)).toBe("Report — 2026-08-22.tar.gz");
  });

  it("stays well under the 255-byte filesystem limit even with a long label", () => {
    const out = archiveFilename("ま".repeat(300), "Workspace", "zip", day);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(200);
    expect(out.endsWith(" — 2026-08-22.zip")).toBe(true);
  });
});
