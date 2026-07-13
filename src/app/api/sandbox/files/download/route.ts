import { lookup } from "mime-types";
import { requireSession, apiHandler } from "@/lib/auth";
import { downloadFile } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget, targetParamsFrom } from "@/lib/sandbox/target";

// The controller serves every file as application/octet-stream. For inline
// previews that's fine for raster images (the browser sniffs them from magic
// bytes even under nosniff) but breaks SVG and PDF, which only render when
// labelled with their real type. Derive a type from the extension, but only for
// the formats actually loaded by URL in <img>/<iframe> — images and PDF — so an
// arbitrary file can't be coaxed into rendering as text/html. Everything else
// stays octet-stream. Safe to serve inline: the response CSP below neuters
// scripts, and an <img>-loaded SVG never executes them regardless.
function inlineContentType(filename: string): string | null {
  const mime = lookup(filename);
  if (mime && (mime.startsWith("image/") || mime === "application/pdf")) return mime;
  return null;
}

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  // Quick Look fetches the same bytes but renders them in-page. `inline` flips
  // the disposition so the browser displays instead of saving.
  const inline = searchParams.get("inline") === "1";

  if (!filePath) return Response.json({ error: "Missing path" }, { status: 400 });

  const { sessionKey } = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });
  const controllerRes = await downloadFile(sessionKey, filePath, userId);

  // Proxy the binary stream from controller to client
  const filename = filePath.split("/").pop() || "file";
  const safeFilename = filename.replace(/[^\x20-\x7E]/g, "_"); // ASCII-safe fallback
  const encodedFilename = encodeURIComponent(filename);

  const disposition = inline
    ? `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
    : `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;

  const headers: Record<string, string> = {
    "Content-Type":
      (inline ? inlineContentType(filename) : null) ||
      controllerRes.headers.get("Content-Type") ||
      "application/octet-stream",
    "Content-Disposition": disposition,
    // Sandbox files are user/AI-supplied; never let the browser MIME-sniff them.
    "X-Content-Type-Options": "nosniff",
  };
  // Only forward Content-Length when the controller actually sent one. It streams
  // chunked (no length), and a fallback of "" produces an invalid empty header
  // that the upstream proxy rejects as a 502 — so omit it and let the body be
  // chunked through.
  const contentLength = controllerRes.headers.get("Content-Length");
  if (contentLength) headers["Content-Length"] = contentLength;
  // Inline content renders from our own origin — lock it down so a malicious
  // file (e.g. an SVG/HTML opened directly) can't execute against the app.
  // `default-src 'none'` neuters scripts; `frame-ancestors 'self'` allows only
  // our own Quick Look iframe.
  if (inline) {
    let csp = "default-src 'none'; frame-ancestors 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'";
    // An SVG served inline can carry an inline <script>. `default-src 'none'`
    // already blocks it (and an <img>-loaded SVG never executes scripts at all),
    // but add the `sandbox` directive as defense-in-depth for a direct navigation
    // to the URL: it forces an opaque origin with scripts/forms disabled. Scoped
    // to SVG only — a blanket `sandbox` can break the browser's native PDF viewer.
    if (headers["Content-Type"] === "image/svg+xml") csp += "; sandbox";
    headers["Content-Security-Policy"] = csp;
  }

  return new Response(controllerRes.body, { headers });
});
