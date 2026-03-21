import { readdir, stat, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { requireSession } from "@/lib/auth";
import { resolveUserPath } from "@/lib/files";

export async function GET(req: Request) {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const relativePath = searchParams.get("path") || "";
  const projectId = searchParams.get("projectId") || undefined;

  let resolved: string;
  try {
    resolved = resolveUserPath(userId, projectId, relativePath);
  } catch {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(resolved, entry.name);
        const info = await stat(fullPath).catch(() => null);
        return {
          name: entry.name,
          path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
          isDirectory: entry.isDirectory(),
          size: info?.size ?? 0,
          modifiedAt: info?.mtime?.toISOString() ?? null,
        };
      }),
    );

    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return Response.json(items);
  } catch {
    return Response.json([]);
  }
}

export async function DELETE(req: Request) {
  const { userId } = await requireSession();
  const { path: relativePath, projectId } = await req.json();
  if (!relativePath) return Response.json({ error: "Missing path" }, { status: 400 });

  let resolved: string;
  try {
    resolved = resolveUserPath(userId, projectId, relativePath);
  } catch {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const info = await stat(resolved);
    if (info.isDirectory()) return Response.json({ error: "Cannot delete directories" }, { status: 400 });
    await unlink(resolved);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
}

export async function POST(req: Request) {
  const { userId } = await requireSession();
  const { action, path: relativePath, name, projectId } = await req.json();

  if (action === "mkdir") {
    if (!name) return Response.json({ error: "Missing name" }, { status: 400 });
    const dirPath = relativePath ? `${relativePath}/${name}` : name;
    let resolved: string;
    try {
      resolved = resolveUserPath(userId, projectId, dirPath);
    } catch {
      return Response.json({ error: "Invalid path" }, { status: 400 });
    }

    try {
      await mkdir(resolved, { recursive: true });
      return Response.json({ ok: true, path: dirPath });
    } catch {
      return Response.json({ error: "Failed to create directory" }, { status: 500 });
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
