/**
 * `view_file` — lets the agent SEE a workspace file, not just read its bytes.
 *
 * The agent renders a file to PNG page(s) inside the sandbox (images as-is,
 * PDFs via pdftoppm, office docs via LibreOffice→PDF, HTML via headless Chromium)
 * and those pages are shown to the vision model. The point: after the agent
 * generates a document it can look at it and catch a broken layout, instead of
 * handing a non-technical user a mangled file.
 *
 * Two delivery paths, chosen by transport (see supportsImageToolResults):
 *  - CAPABLE (anthropic/google/openrouter/openai-Responses): the image rides
 *    the tool result via `toModelOutput` — the provider adapter turns an
 *    `image-data` part into a real image block.
 *  - BRIDGE (openai chat + openai-compatible / LiteLLM …): chat-completions has
 *    no image slot in a `tool` message (the adapter JSON.stringifies it), so the
 *    tool result stays a small JSON ref and the runner injects the rendered pages
 *    as a following `user` message via prepareStep (see buildViewFileInjection).
 *
 * Either way the PERSISTED tool output is a tiny ref (never base64) — replay-safe
 * and DB-safe. The bytes are re-downloaded per step from the workspace; on a
 * later turn the model sees the ref and calls view_file again to look afresh.
 */

import { tool, type ModelMessage, type JSONValue } from "ai";
import { z } from "zod";
import { execCommand, downloadFile } from "./client";
import { log } from "@/lib/log";

const VIEW_DIR = "/workspace/.capka/view";
const VIEW_KEEP = Number(process.env.VIEW_KEEP_DIRS) || 4;
const MAX_PAGES = 4;
const RENDER_PX = 1536; // long-edge target — a document page at this size is well under the cap
const MAX_IMG_BYTES = 3 * 1024 * 1024; // per page; Anthropic's per-image ceiling is ~5 MB
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export type MediaRef = {
  kind: "media";
  source: string;
  mime: string;
  pageCount: number;
  pages: { page: number; path: string }[];
  note: string;
};

export function isMediaRef(v: unknown): v is MediaRef {
  return !!v && typeof v === "object" && (v as MediaRef).kind === "media" && Array.isArray((v as MediaRef).pages);
}

type ViewKind = "image" | "pdf" | "office" | "html";

function classify(ext: string): ViewKind | null {
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["docx", "doc", "odt", "pptx", "ppt", "odp", "xlsx", "xls", "ods", "rtf"].includes(ext)) return "office";
  if (["html", "htm"].includes(ext)) return "html";
  return null;
}

/** Requested page numbers, sanitized to a capped list of positive ints. */
function normalizePages(pages?: number[]): number[] {
  const clean = (pages ?? [])
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_PAGES);
  return clean.length ? clean : Array.from({ length: MAX_PAGES }, (_, i) => i + 1);
}

/** Rasterize selected pages of `$src` (a PDF) into `$d/p-<n>.png`, echoing each
 *  produced path and the total page count. Shared by the pdf and office paths. */
function pdfTail(wanted: number[]): string {
  return `n=$(pdfinfo "$src" 2>/dev/null | awk '/^Pages:/{print $2}'); [ -z "$n" ] && n=0
echo __COUNT__$n
for p in ${wanted.join(" ")}; do
  [ "$p" -le "$n" ] || continue
  pdftoppm -png -singlefile -scale-to ${RENDER_PX} -f "$p" -l "$p" "$src" "$d/p-$p" && echo __PNG__"$d/p-$p.png"
done`;
}

/** Build the (self-contained) bash that renders `path` into a fresh call dir. */
function renderScript(kind: ViewKind, path: string, dir: string, wanted: number[]): string {
  const safe = path.replace(/'/g, "'\\''");
  const head = `d='${dir}'
mkdir -p "$d"
( cd '${VIEW_DIR}' && ls -1td */ 2>/dev/null | tail -n +${VIEW_KEEP + 1} | xargs -r rm -rf )
src='${safe}'
if [ ! -f "$src" ]; then echo __NOFILE__; exit 0; fi`;

  switch (kind) {
    case "image":
      // `[0]` takes the first frame of a multi-frame image; `>` only shrinks.
      return `${head}
echo __COUNT__1
convert "$src[0]" -resize '${RENDER_PX}x${RENDER_PX}>' "$d/p-1.png" && echo __PNG__"$d/p-1.png"`;
    case "pdf":
      return `${head}\n${pdfTail(wanted)}`;
    case "office":
      // LibreOffice → PDF, then the shared PDF rasterization on the produced file.
      return `${head}
soffice --headless --convert-to pdf --outdir "$d" "$src" >/dev/null 2>&1
src="$d/$(basename "\${src%.*}").pdf"
if [ ! -f "$src" ]; then echo __NOFILE__; exit 0; fi
${pdfTail(wanted)}`;
    case "html":
      // Headless Chromium full-page screenshot; needs an absolute file:// URL.
      return `${head}
case "$src" in /*) f="$src";; *) f="$PWD/$src";; esac
echo __COUNT__1
chromium --headless --no-sandbox --disable-gpu --hide-scrollbars --screenshot="$d/p-1.png" --window-size=1280,2000 "file://$f" >/dev/null 2>&1
[ -f "$d/p-1.png" ] && echo __PNG__"$d/p-1.png"`;
  }
}

const pageNum = (p: string): number => {
  const m = p.match(/\/p-(\d+)\.png$/);
  return m ? parseInt(m[1], 10) : 1;
};

/** Download rendered pages back from the workspace, bounded per-page and in
 *  aggregate (mirrors the runner's downloadBounded). Buffers, not base64 — each
 *  consumer encodes as it needs. Never throws: a failed page is skipped. */
export async function hydrateMediaRef(
  ref: MediaRef,
  sessionKey: string,
  userId: string,
): Promise<{ pages: { page: number; buf: Buffer }[]; skipped: number[] }> {
  const out: { page: number; buf: Buffer }[] = [];
  const skipped: number[] = [];
  let total = 0;
  for (const pg of ref.pages) {
    try {
      const res = await downloadFile(sessionKey, pg.path, userId);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMG_BYTES || total + buf.length > MAX_TOTAL_BYTES) {
        skipped.push(pg.page);
        continue;
      }
      total += buf.length;
      out.push({ page: pg.page, buf });
    } catch (e) {
      skipped.push(pg.page);
      log.warn("view_file: page download failed", { userId, path: pg.path, err: String(e) });
    }
  }
  return { pages: out, skipped };
}

const skippedNote = (skipped: number[]): string =>
  skipped.length ? ` (skipped page(s) too large to show: ${skipped.join(", ")})` : "";

/**
 * BRIDGE path. If the last message is a `view_file` tool result carrying a media
 * ref (chat-completions can't put the image in the tool result itself), return a
 * `user` message with the rendered pages to append for this step. Returns null
 * when there's nothing to inject — so the runner only overrides `messages` (and
 * pays the cache cost) on the exact step after a view_file call.
 */
export async function buildViewFileInjection(
  messages: ModelMessage[],
  sessionKey: string,
  userId: string,
): Promise<ModelMessage | null> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "tool" || !Array.isArray(last.content)) return null;

  const refs: MediaRef[] = [];
  for (const part of last.content) {
    const output = (part as { output?: { type?: string; value?: unknown } }).output;
    // No toModelOutput on the bridge path ⇒ the raw execute() return sits in a
    // `json` output. (Guard the bare shape too, in case a provider passed it through.)
    const value = output?.type === "json" ? output.value : output;
    if (isMediaRef(value)) refs.push(value);
  }
  if (refs.length === 0) return null;

  const content: ({ type: "text"; text: string } | { type: "image"; image: Buffer; mediaType: string })[] = [];
  for (const ref of refs) {
    const { pages, skipped } = await hydrateMediaRef(ref, sessionKey, userId);
    if (pages.length === 0) continue;
    content.push({
      type: "text",
      text: `Rendered page(s) of ${ref.source}${skippedNote(skipped)}:`,
    });
    for (const pg of pages) content.push({ type: "image", image: pg.buf, mediaType: "image/png" });
  }
  if (content.length === 0) return null;
  return { role: "user", content };
}

const DESCRIPTION =
  "See a file the way it renders, not just its bytes: returns image(s) of the file's page(s). " +
  "Handles images, PDFs, office documents (docx/pptx/xlsx/odt…), and HTML. " +
  `Shows up to ${MAX_PAGES} pages per call — page through a longer file with pages:[5,6,7,8]. ` +
  "Use this to CHECK YOUR OWN WORK: after you generate a document, PDF, chart image, or HTML page, " +
  "view it before handing it to the user, so you catch a broken layout or a rendering error. " +
  "For plain text/code/CSV use read_file instead.";

/**
 * @param emitImageToolResult true on transports whose adapter serializes an image
 *   inside a tool result (supportsImageToolResults). false ⇒ bridge path: the
 *   tool returns the raw ref and the runner injects the pages via prepareStep.
 */
export function makeViewFileTool(opts: {
  sessionKey: string;
  userId: string;
  ensureSession: () => Promise<unknown>;
  emitImageToolResult: boolean;
}) {
  const { sessionKey, userId, ensureSession, emitImageToolResult } = opts;

  const view_file = tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      path: z.string().describe("File path relative to /workspace"),
      pages: z.array(z.number()).optional().describe(`Which pages to render (1-based). Default: first ${MAX_PAGES}.`),
    }),
    execute: async ({ path, pages }): Promise<MediaRef | { error: string }> => {
      await ensureSession();
      const ext = (path.toLowerCase().split(".").pop() ?? "").trim();
      const kind = classify(ext);
      if (!kind) {
        return {
          error: `Can't render a .${ext} file to an image. If it's text, use read_file; for other binaries inspect it with execute_bash.`,
        };
      }
      const callId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const dir = `${VIEW_DIR}/${callId}`;
      const wanted = normalizePages(pages);
      const res = await execCommand(sessionKey, renderScript(kind, path, dir, wanted), 300_000);
      if (res.stdout.includes("__NOFILE__")) return { error: `File not found: ${path}` };
      const produced = [...res.stdout.matchAll(/__PNG__(.+)/g)].map((m) => m[1].trim()).filter(Boolean);
      if (produced.length === 0) {
        const why = (res.stderr || res.stdout || "").replace(/__\w+__.*/g, "").trim().slice(0, 300);
        return { error: `Could not render ${path}${why ? `: ${why}` : "."}` };
      }
      const countMatch = res.stdout.match(/__COUNT__(\d+)/);
      const pageCount = countMatch ? parseInt(countMatch[1], 10) : produced.length;
      return {
        kind: "media",
        source: path,
        mime: "image/png",
        pageCount: pageCount || produced.length,
        // Paths are stored RELATIVE to /workspace — that's what downloadFile and the
        // download route resolve against (an absolute /workspace/… escapes the store base).
        pages: produced.map((p) => ({ page: pageNum(p), path: p.replace(/^\/workspace\//, "") })),
        note: "The rendered page(s) were shown to you as image(s). To look again later, call view_file again.",
      };
    },
    // On the BRIDGE transport, hand the model the raw ref (== the SDK's default
    // json wrapping) — the pages arrive via prepareStep as a user message, and
    // buildViewFileInjection reads the ref back from this json output. On a CAPABLE
    // transport, hydrate the ref into image-data parts here. Never throws: a throw
    // in toModelOutput kills the stream, so any failure degrades to text.
    toModelOutput: async ({ output }) => {
      if (!emitImageToolResult) return { type: "json" as const, value: output as JSONValue };
      try {
        if (!isMediaRef(output)) {
          return { type: "content" as const, value: [{ type: "text" as const, text: (output as { error?: string }).error ?? "Nothing to show." }] };
        }
        const { pages, skipped } = await hydrateMediaRef(output, sessionKey, userId);
        const shown = pages.length;
        const value: ({ type: "text"; text: string } | { type: "image-data"; data: string; mediaType: string })[] = [
          {
            type: "text",
            text: `${output.source} — showing ${shown} page(s)${output.pageCount > shown ? ` of ${output.pageCount}` : ""}${skippedNote(skipped)}.`,
          },
        ];
        for (const pg of pages) value.push({ type: "image-data", data: pg.buf.toString("base64"), mediaType: "image/png" });
        if (shown === 0) value.push({ type: "text", text: "The pages were rendered but could not be loaded back." });
        return { type: "content", value };
      } catch (e) {
        log.warn("view_file: toModelOutput failed", { userId, err: String(e) });
        return { type: "content", value: [{ type: "text", text: "Rendered the file but could not attach the image(s)." }] };
      }
    },
  });

  return { view_file };
}
