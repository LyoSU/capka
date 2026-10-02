// pdf.js's parser, as a module worker the bundler emits on its own: importing the
// prebuilt worker in a worker scope is what starts its message handler.
import "pdfjs-dist/build/pdf.worker.min.mjs";
