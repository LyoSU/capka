/**
 * What the sandbox image is supposed to be able to do, as data.
 *
 * Two lists, two consumers, one edit each to add something:
 *   TOOLS        — presence + version. Checked during `docker build` (§10 of
 *                  Dockerfile.sandbox), where it also renders /opt/capka/TOOLS.md
 *                  so the agent can find out what it has without guessing. A
 *                  missing tool fails the build.
 *   CAPABILITIES — must produce a real artifact with real content. These CANNOT be
 *                  checked at build time: `docker build` runs as root on a writable
 *                  rootfs, which is exactly the condition that hid the worst bug
 *                  this file exists to catch — with the container's read-only
 *                  rootfs, LibreOffice and Chromium could not create a profile
 *                  under $HOME and produced no output at all, silently. They run in
 *                  scripts/sandbox-smoke.mjs, in a container built by the real
 *                  DockerBackend so the posture cannot drift from production's.
 *
 * `want` is deliberately a content assertion, not "the file exists": every defect
 * this suite was written for produced either no file or a file with nothing in it.
 *
 * Probes silence stdout but NEVER stderr. An early version used `>/dev/null 2>&1`
 * and three real failures reported "(empty)" — a failure that cannot say why it
 * failed sends the next hour somewhere useless.
 */

/** Tools whose absence should fail the build. `version` also feeds TOOLS.md. */
export const TOOLS = [
  { bin: "python3", version: "python3 -V", note: "Python 3.12 with the data/document stack" },
  { bin: "node", version: "node -v", note: "Node.js 22" },
  // Asked of dpkg, not of soffice: the on-PATH `soffice` is the xvfb-run shim, so
  // `--version` needs an X server and prints a wall of xkbcomp warnings first.
  { bin: "soffice", version: "dpkg-query -W -f='${Version}' libreoffice-core", note: "LibreOffice — office formats to/from PDF" },
  { bin: "pandoc", version: "pandoc --version | head -1", note: "Markup conversion; `-o x.pdf` goes through weasyprint" },
  { bin: "typst", version: "typst --version", note: "Typesetting for .typ sources" },
  { bin: "weasyprint", version: "weasyprint --version", note: "HTML/CSS to PDF" },
  { bin: "html2pdf", version: "echo shim", note: "URL or .html to PDF via headless Chromium" },
  { bin: "mmdc", version: "echo shim", note: "Mermaid diagram to .svg/.png/.pdf" },
  { bin: "chromium", version: "chromium --version", note: "Headless browser; Playwright drives the same build" },
  { bin: "gs", version: "gs --version", note: "Ghostscript — PDF recompression, rasterising, PS/EPS" },
  { bin: "qpdf", version: "qpdf --version | head -1", note: "Lossless PDF structure edits" },
  { bin: "pdftotext", version: "pdftotext -v 2>&1 | head -1", note: "Poppler text extraction" },
  { bin: "ocrmypdf", version: "ocrmypdf --version", note: "Adds a searchable text layer to a scan" },
  { bin: "tesseract", version: "tesseract --version | head -1", note: "OCR; English and Ukrainian installed" },
  { bin: "ffmpeg", version: "ffmpeg -version | head -1", note: "Audio and video" },
  { bin: "convert", version: "convert --version | head -1", note: "ImageMagick" },
  { bin: "duckdb", version: "duckdb --version", note: "SQL over CSV/Parquet/JSON files" },
  { bin: "jq", version: "jq --version", note: "JSON" },
  { bin: "yq", version: "yq --version", note: "YAML" },
  { bin: "sqlite3", version: "sqlite3 --version", note: "SQLite" },
  { bin: "aria2c", version: "aria2c --version | head -1", note: "Resumable downloads" },
  { bin: "7z", version: "7z i | head -2 | tail -1", note: "7-Zip archives" },
  { bin: "rg", version: "rg --version | head -1", note: "ripgrep" },
  { bin: "git", version: "git --version", note: "git" },
];

/** Python modules whose absence should fail the build (import is enough here). */
export const MODULES = [
  "pandas", "numpy", "scipy", "sklearn", "matplotlib", "polars", "duckdb",
  "docx", "openpyxl", "pptx", "odf", "python_calamine", "pypdf", "pikepdf", "pdfplumber",
  "camelot", "reportlab", "PIL", "cv2", "playwright", "markitdown", "magika", "weasyprint",
  "msoffcrypto", "extract_msg", "pytesseract", "bs4", "httpx",
];

/**
 * Wrappers that must NOT be installed unless the binary they wrap is present and a
 * real conversion succeeds. `pdfkit` shipped for months importable and non-functional
 * — wkhtmltopdf was deliberately removed for a CVSS-9.8 SSRF — so the agent saw a
 * usable module, spent a turn on it, and got an OSError. An importable module that
 * cannot work is worse than an absent one.
 */
export const MUST_BE_ABSENT = [
  { module: "pdfkit", unless: "wkhtmltopdf", why: "wrapper for a binary this image deliberately does not ship" },
  { module: "tabula", unless: "java", why: "needs a JVM; camelot and pdfplumber cover table extraction" },
];

/**
 * The real work. Each entry runs in /workspace inside a container created by the
 * production spec, as uid 1000, and must leave content behind.
 */
export const CAPABILITIES = [
  {
    name: "office document to PDF",
    cmd: `python3 -c "import docx;d=docx.Document();d.add_paragraph('Тест кирилиці');d.save('a.docx')" \
&& soffice --headless --convert-to pdf --outdir . a.docx >/dev/null && pdftotext a.pdf -`,
    want: /Тест кирилиці/,
  },
  {
    name: "HTML to PDF (headless Chromium)",
    cmd: `printf '<h1>Привіт</h1>' > b.html && html2pdf b.html b.pdf >/dev/null && pdftotext b.pdf -`,
    want: /Привіт/,
  },
  {
    name: "Markdown to PDF (pandoc engine shim)",
    cmd: `printf '# Заголовок\\n\\nАбзац.\\n' > c.md && pandoc c.md -o c.pdf && pdftotext c.pdf -`,
    want: /Заголовок/,
  },
  {
    name: "mermaid diagram to SVG",
    cmd: `printf 'graph TD\\n A[Початок] --> B[Кінець]\\n' > d.mmd && mmdc -i d.mmd -o d.svg >/dev/null && cat d.svg`,
    want: /Початок/,
  },
  {
    name: "Ukrainian OCR",
    cmd: `python3 -c "
from PIL import Image, ImageDraw, ImageFont
f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 40)
im = Image.new('RGB', (700, 100), 'white')
ImageDraw.Draw(im).text((10, 25), 'Річний звіт', font=f, fill='black')
im.save('e.png')" && tesseract e.png - -l ukr`,
    want: /Річний/,
  },
  {
    name: "searchable PDF from a scan",
    cmd: `python3 -c "import img2pdf;open('f.pdf','wb').write(img2pdf.convert('e.png'))" \
&& ocrmypdf -l ukr --output-type pdf f.pdf g.pdf >/dev/null && pdftotext g.pdf -`,
    want: /Річний/,
    needs: "Ukrainian OCR",
  },
  {
    name: "parquet round-trip",
    // pandas, polars and the duckdb module each read it: the image once had pandas
    // with no parquet engine at all, so a .parquet file was simply unreadable.
    cmd: `python3 -c "
import pandas as pd, polars as pl, duckdb
pd.DataFrame({'a': [1, 2]}).to_parquet('h.parquet')
print('rows', len(pd.read_parquet('h.parquet')), pl.read_parquet('h.parquet').height,
      duckdb.sql(\\"select count(*) from 'h.parquet'\\").fetchone()[0])"`,
    want: /rows 2 2 2/,
  },
  {
    name: "office document to Markdown",
    // markitdown shipped without its extras: the import succeeded and every
    // conversion raised MissingDependencyException.
    cmd: `python3 -c "
from markitdown import MarkItDown
print(MarkItDown().convert('a.docx').text_content)"`,
    want: /Тест кирилиці/,
    needs: "office document to PDF",
  },
  {
    name: "spreadsheet via the fast Excel reader",
    cmd: `python3 -c "
import pandas as pd
pd.DataFrame({'a': [1]}).to_excel('i.xlsx', index=False)
print('cells', len(pd.read_excel('i.xlsx', engine='calamine')))"`,
    want: /cells 1/,
  },
  {
    name: "ghostscript rewrites a PDF",
    cmd: `gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile=j.pdf b.pdf >/dev/null && pdftotext j.pdf -`,
    want: /Привіт/,
    needs: "HTML to PDF (headless Chromium)",
  },
  {
    name: "writable HOME",
    // The one that produced no error message anywhere: with $HOME on the read-only
    // rootfs, LibreOffice and Chromium simply wrote nothing.
    cmd: `touch "$HOME/.probe" && echo "home ok $HOME"`,
    want: /home ok \/home\/sandbox/,
  },
];
