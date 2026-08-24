import { lookup } from "mime-types";
import { requireSession, apiHandler } from "@/lib/auth";
import { downloadSharedFile } from "@/lib/sandbox/client";
import { safeFilename, contentDisposition } from "@/lib/download-filename";

// Download one file out of the per-user shared store. Mirrors the workspace
// download proxy — same filename sanitizing, same content-type narrowing, same
// nosniff/CSP posture — because the bytes have the same provenance: written by
// the agent inside a sandbox.
function inlineContentType(filename: string): string | null {
  const mime = lookup(filename);
  if (mime && (mime.startsWith("image/") || mime === "application/pdf")) return mime;
  return null;
}

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  const inline = searchParams.get("inline") === "1";
  if (!filePath) return Response.json({ error: "Missing path" }, { status: 400 });

  const controllerRes = await downloadSharedFile(userId, filePath);

  const rawName = filePath.split("/").pop() || "file";
  const filename = safeFilename(rawName, "file");
  const headers: Record<string, string> = {
    "Content-Type":
      (inline ? inlineContentType(rawName) : null) ||
      controllerRes.headers.get("Content-Type") ||
      "application/octet-stream",
    "Content-Disposition": contentDisposition(filename, inline ? "inline" : "attachment"),
    "X-Content-Type-Options": "nosniff",
  };
  const contentLength = controllerRes.headers.get("Content-Length");
  if (contentLength) headers["Content-Length"] = contentLength;
  if (inline) {
    let csp = "default-src 'none'; frame-ancestors 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'";
    if (headers["Content-Type"] === "image/svg+xml") csp += "; sandbox";
    headers["Content-Security-Policy"] = csp;
  }

  return new Response(controllerRes.body, { headers });
});
