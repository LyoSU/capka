import { getDocument, PDFWorker, type PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";

// pdf.js's legacy build, not the default one: the default build calls APIs only
// the newest engines have (Promise.try, Map#getOrInsert), so on an iPhone a
// release or two behind it would fail exactly where this viewer exists to work.

let shared: PDFWorker | null = null;

/**
 * pdf.js's worker: ONE for the page's lifetime, handed to every getDocument, so a
 * loading task's destroy() never touches it (pdf.js only tears down workers it
 * created itself).
 *
 * Left to pdf.js (via GlobalWorkerOptions.workerPort) the worker belongs to the
 * task: destroying one marks the port's worker "being destroyed" until that async
 * teardown settles, and a getDocument in that window THROWS. React Strict Mode's
 * second effect run lands in that window every time, as does closing a PDF and
 * opening another quickly — and the throw went straight to the error boundary,
 * which replaced the whole page.
 *
 * `create` is for tests, which run pdf.js without a browser Worker.
 */
export function pdfWorker(create?: () => PDFWorker): PDFWorker {
  if (!shared || shared.destroyed) {
    shared = create
      ? create()
      : PDFWorker.create({ port: new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module" }) });
  }
  return shared;
}

/** Start loading a PDF from bytes. The bytes are copied: pdf.js transfers what it
 *  is given to the worker, and the caller may load the same buffer again. */
export function openPdf(data: ArrayBuffer): PDFDocumentLoadingTask {
  return getDocument({ data: new Uint8Array(data.slice(0)), worker: pdfWorker(), enableXfa: false });
}
