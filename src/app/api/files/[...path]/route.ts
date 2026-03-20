import { readFile, lstat } from "fs/promises";
import { requireSession } from "@/lib/auth";
import { resolveUserPath, getMimeType, sanitizeFilename, assertNoSymlinkEscape, DANGEROUS_CONTENT_TYPES } from "@/lib/files";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { userId } = await requireSession();
  const { path: segments } = await params;
  const relativePath = segments.join("/");
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId") || undefined;

  let resolved: string;
  try {
    resolved = resolveUserPath(userId, projectId, relativePath);
  } catch {
    return new Response("Invalid path", { status: 400 });
  }

  try {
    const info = await lstat(resolved);
    if (info.isDirectory()) return new Response("Cannot download a directory", { status: 400 });

    // Symlink protection
    if (info.isSymbolicLink()) {
      await assertNoSymlinkEscape(resolved, userId, projectId);
    }

    const buffer = await readFile(resolved);
    const mimeType = getMimeType(relativePath);
    const filename = sanitizeFilename(segments[segments.length - 1]);
    const disposition = DANGEROUS_CONTENT_TYPES.has(mimeType) ? "attachment" : "inline";

    return new Response(buffer, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": info.size.toString(),
        "Content-Disposition": `${disposition}; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("escape")) return new Response("Forbidden", { status: 403 });
    return new Response("File not found", { status: 404 });
  }
}
