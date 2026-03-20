import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { requireSession } from "@/lib/auth";
import { resolveUserPath } from "@/lib/files";

const MAX_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(req: Request) {
  const { userId } = await requireSession();
  const formData = await req.formData();
  const files = formData.getAll("file") as File[];
  const relativePath = (formData.get("path") as string) || "";
  const projectId = (formData.get("projectId") as string) || undefined;

  if (!files.length) return Response.json({ error: "No files provided" }, { status: 400 });

  let baseDir: string;
  try {
    baseDir = resolveUserPath(userId, projectId, relativePath);
  } catch {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }

  await mkdir(baseDir, { recursive: true });
  const results = [];

  for (const file of files) {
    if (file.size > MAX_SIZE) {
      results.push({ name: file.name, error: "File too large (max 50MB)" });
      continue;
    }

    let resolved: string;
    try {
      resolved = resolveUserPath(userId, projectId, relativePath ? `${relativePath}/${file.name}` : file.name);
    } catch {
      results.push({ name: file.name, error: "Invalid filename" });
      continue;
    }

    try {
      await mkdir(dirname(resolved), { recursive: true });
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(resolved, buffer);
      results.push({ name: file.name, path: relativePath ? `${relativePath}/${file.name}` : file.name, size: file.size });
    } catch {
      results.push({ name: file.name, error: "Upload failed" });
    }
  }

  return Response.json(results);
}
