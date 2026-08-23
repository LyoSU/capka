#!/usr/bin/env node
/**
 * Runs INSIDE `docker build` (§10 of Dockerfile.sandbox), at the end, and does two
 * jobs from one list:
 *
 *   1. Fails the build if a tool or Python module in scripts/sandbox-capabilities.mjs
 *      is missing. Cheap, and it catches a typo'd package name at the layer that
 *      introduced it rather than in a container weeks later.
 *   2. Writes /opt/capka/TOOLS.md — what the sandbox actually contains, with the
 *      versions that actually resolved. Generated, so it cannot drift from the image
 *      the way a hand-written list in a prompt does.
 *
 * It deliberately does NOT try to verify capabilities. A build runs as root on a
 * writable rootfs, so LibreOffice and Chromium succeed here even when they cannot
 * work in the real container — which is exactly how they shipped broken. That half
 * belongs to sandbox-controller/smoke-image.mjs.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { TOOLS, MODULES } from "./sandbox-capabilities.mjs";

// A shell is required here, not incidental: the `version` fields are pipelines
// ("pandoc --version | head -1"). Everything interpolated comes from the literals
// in sandbox-capabilities.mjs, so there is no untrusted input — keep it that way,
// and never build one of these strings from anything the agent or a user supplied.
const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const missing = [];
const rows = [];

for (const { bin, version, note } of TOOLS) {
  try {
    sh(`command -v ${bin}`);
  } catch {
    missing.push(`binary ${bin}`);
    continue;
  }
  let v = "";
  try {
    v = sh(version).split("\n")[0].slice(0, 60);
  } catch (err) {
    // A tool that cannot report a version is still installed, so this does not fail
    // the build over a --version flag we guessed wrong — but it says WHY on the build
    // log. A bare "(no version output)" in the manifest is a hole that cannot be
    // diagnosed later, which is how the soffice row sat wrong for a build.
    console.warn(`  version probe failed for ${bin}: ${String(err.message || err).split("\n")[0]}`);
    v = "(version unavailable)";
  }
  rows.push({ bin, v, note });
}

for (const mod of MODULES) {
  try {
    sh(`python3 -c "import ${mod}"`);
  } catch {
    missing.push(`python module ${mod}`);
  }
}

if (missing.length) {
  console.error(`sandbox image is missing ${missing.length} declared item(s):`);
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

const manifest = `# What this sandbox has

Generated when the image was built — this file and the image cannot disagree.
Everything below is already installed; there is no need to install it again, and
nothing here needs network access.

| Command | Version | What it is for |
|---|---|---|
${rows.map(({ bin, v, note }) => `| \`${bin}\` | ${v} | ${note} |`).join("\n")}

Python has the data and document stack preinstalled (pandas, polars, duckdb, numpy,
scipy, scikit-learn, matplotlib, Pillow, OpenCV, python-docx, python-pptx, openpyxl,
python-calamine, pypdf, pikepdf, pdfplumber, camelot, reportlab, markitdown,
weasyprint, msoffcrypto-tool, extract-msg, playwright). Node has typescript, tsx,
sharp, pdf-lib, docx and pptxgenjs.

Notes that are easy to get wrong:

- \`pandoc file.md -o file.pdf\` works; it renders through weasyprint, not LaTeX.
  There is no \`pdflatex\` in this image. For real typesetting use \`typst\`.
- OCR has English and Ukrainian: \`tesseract scan.png - -l ukr\`. To make a scanned
  PDF searchable without rebuilding it, use \`ocrmypdf -l ukr in.pdf out.pdf\`.
- \`mmdc -i diagram.mmd -o diagram.svg\` renders mermaid to a file. It supports
  \`-t\`, \`-b\`, \`-w\`, \`-H\` and \`-s\`; other mermaid-cli flags are not implemented
  and will be refused rather than ignored.
- Large tables: \`duckdb\` (CLI or Python) and \`polars\` read CSV and Parquet larger
  than memory. Read big spreadsheets with \`pd.read_excel(..., engine="calamine")\`.
- \`/workspace\` persists between messages. \`$HOME\` and \`/tmp\` are small and are
  wiped with the session, so put files the user should get in \`/workspace\`.
`;

mkdirSync("/opt/capka", { recursive: true });
writeFileSync("/opt/capka/TOOLS.md", manifest);
console.log(`sandbox manifest: ${rows.length} tools, ${MODULES.length} modules verified`);
