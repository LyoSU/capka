// pdf.js's parser, as a module worker the bundler emits on its own: importing the
// prebuilt worker in a worker scope is what starts its message handler. The
// legacy build, to match the main thread (see pdf-load.ts).
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
