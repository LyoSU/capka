import { apiHandler, requireActive } from "@/lib/auth";
import { uploadFile } from "@/lib/sandbox/client";
import { requireOwned } from "@/lib/db/ownership";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { chats } from "@/lib/db/schema";
import { take } from "@/lib/rate-limit";
import { pcFolderLevel } from "@/lib/manage/controls/folders";

// Bulk upload for PC-folder sync: MANY files in one request, written under
// /workspace/<name>/<relpath>. Each file's form name is its path relative to the
// folder. This exists so folder sync doesn't hammer the interactive per-file
// upload limiter (10/min) — a folder with dozens of files would 429 instantly.
// Rate-limited per REQUEST (generously), not per file.
export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireActive();
  const level = await pcFolderLevel();
  if (level === "off" || (level === "admins" && role !== "admin")) {
    return Response.json({ error: "Personal folder access is disabled." }, { status: 403 });
  }
  // 60-request burst, ~1/s refill — a batch is up to CHUNK files (see the bridge),
  // so this comfortably covers a large folder while still bounding abuse.
  const rl = take(`folder-upload:${userId}`, 60, 1);
  if (!rl.ok) return Response.json({ error: "Too many uploads — please slow down." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const form = await req.formData();
  const chatId = form.get("chatId") as string | null;
  const name = form.get("name") as string | null;
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!chatId || !name || files.length === 0) return Response.json({ error: "Missing chatId, name, or files" }, { status: 400 });

  const chat = await requireOwned(chats, chatId, userId, "Chat");
  const key = workspaceSessionKey({ id: chatId, projectId: (chat.projectId as string | null) ?? null });

  for (const f of files) {
    const rel = f.name; // path relative to the folder, e.g. "sub/a.txt"
    const slash = rel.lastIndexOf("/");
    const dir = slash >= 0 ? `${name}/${rel.slice(0, slash)}` : name;
    const filename = slash >= 0 ? rel.slice(slash + 1) : rel;
    await uploadFile(key, dir, new File([f], filename), userId);
  }
  return Response.json({ ok: true, count: files.length });
});
