import { parseSheetFile } from "@/lib/sheet-model";

// Spreadsheets come from users and the agent, so they are parsed off the main
// thread: a hostile or just enormous file can stall this worker, never the page,
// and the viewer terminates it on a timeout.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ bytes: ArrayBuffer; ext: string }>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (e) => {
  try {
    scope.postMessage({ ok: true, sheets: parseSheetFile(new Uint8Array(e.data.bytes), e.data.ext) });
  } catch {
    scope.postMessage({ ok: false });
  }
};
