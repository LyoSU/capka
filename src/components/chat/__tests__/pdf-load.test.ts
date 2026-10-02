import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { GlobalWorkerOptions, PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs";
import { openPdf, pdfWorker } from "../viewers/pdf-load";

/** A two-page PDF written by hand, with a correct cross-reference table. */
function twoPagePdf(): ArrayBuffer {
  const page = (content: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
  const stream = (text: string) => {
    const body = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
    return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    page(6),
    page(7),
    stream("One"),
    stream("Two"),
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out).buffer as ArrayBuffer;
}

describe("openPdf", () => {
  // Node has no browser Worker: pdf.js runs its "fake" in-thread worker from this file.
  GlobalWorkerOptions.workerSrc = createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const worker = pdfWorker(() => new PDFWorker());

  it("opens a document again while the previous load is still being destroyed", async () => {
    // React Strict Mode's mount → unmount → mount, or a quick close-and-reopen:
    // the first task's destroy() is NOT awaited before the next getDocument. With
    // a per-task worker that second call threw "the worker is being destroyed".
    const data = twoPagePdf();
    const first = openPdf(data);
    void first.destroy();
    const second = openPdf(data);
    const doc = await second.promise;
    expect(doc.numPages).toBe(2);
    await second.destroy();
    // The worker outlives every task, so the next viewer gets the same one.
    expect(worker.destroyed).toBe(false);
    expect(pdfWorker()).toBe(worker);
  });

  it("leaves the caller's buffer usable for the next load", async () => {
    const data = twoPagePdf();
    const a = openPdf(data);
    await a.promise;
    await a.destroy();
    expect(data.byteLength).toBeGreaterThan(0); // not transferred away
    const b = openPdf(data);
    expect((await b.promise).numPages).toBe(2);
    await b.destroy();
  });

  it("rejects (never throws) for bytes that are not a PDF", async () => {
    const task = openPdf(new TextEncoder().encode("not a pdf").buffer as ArrayBuffer);
    await expect(task.promise).rejects.toBeTruthy();
    await task.destroy();
  });
});
