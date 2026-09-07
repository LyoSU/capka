import { apiHandler, requireActive } from "@/lib/auth";
import { pool } from "@/lib/db";
import { liveLeaseSql } from "@/lib/folders/lease";
import { uploadFile } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget } from "@/lib/sandbox/target";
import { take } from "@/lib/rate-limit";
import { pcFolderLevel, canAttachPc } from "@/lib/manage/controls/folders";
import { ignoredPath, oversized } from "@/lib/folder-bridge/filter";

// Bulk upload for PC-folder sync: MANY files in one request, written under
// /workspace/<name>/<relpath>. Each file's form name is its path relative to the
// folder. This exists so folder sync doesn't hammer the interactive per-file
// upload limiter (10/min) — a folder with dozens of files would 429 instantly.
// Rate-limited per REQUEST (generously), not per file.
export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireActive();
  if (!canAttachPc(await pcFolderLevel(), role === "admin")) {
    return Response.json({ error: "Personal folder access is disabled." }, { status: 403 });
  }
  // 60-request burst, ~1/s refill — a batch is up to CHUNK files (see the bridge),
  // so this comfortably covers a large folder while still bounding abuse.
  const rl = take(`folder-upload:${userId}`, 60, 1);
  if (!rl.ok) return Response.json({ error: "Too many uploads — please slow down." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const form = await req.formData();
  const chatId = form.get("chatId") as string | null;
  const projectId = form.get("projectId") as string | null;
  const name = form.get("name") as string | null;
  const lease = form.get("lease") as string | null;
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!name || files.length === 0) return Response.json({ error: "Missing name or files" }, { status: 400 });

  const { sessionKey: key } = await resolveWorkspaceTarget({ userId, chatId, projectId });

  // A sync claims the folder with a lease and holds it for its whole span, but the
  // client alone cannot enforce that: a batch already assembled goes out even if the
  // lease lapsed while its files were being read, and a stale tab's writes used to
  // be accepted here unconditionally. So a batch that names a lease must still hold
  // it, checked against the row this request is about to write into.
  //
  // Absent means "no lease claimed" and behaves as before — the one-shot fallback
  // import has no folder row to check against, and neither does any non-sync caller.
  if (lease) {
    const { rows } = await pool.query(
      `SELECT 1 FROM attached_folders WHERE session_key = $1 AND name = $2 AND ${liveLeaseSql(3)}`,
      [key, name, lease],
    );
    if (!rows[0]) {
      return Response.json({ error: "Another window took over syncing this folder.", code: "LEASE_GONE" }, { status: 409 });
    }
  }

  // The client-side skip-list and size cap are conveniences, not a boundary — a
  // hand-crafted request could otherwise smuggle a dependency tree or an oversized
  // blob into the sandbox. Re-apply the same filter here. (Writes are already
  // confined to the caller's own workspace by requireOwned + the controller's
  // path-safety, and bounded by the workspace quota, so no folder-row check is
  // needed on top — and the one-shot fallback import has no row to check against.)
  const accepted = files.filter((f) => !ignoredPath(f.name) && !oversized(f.size)); // mirror the client filter
  // Upload with bounded concurrency: each file is an independent POST to the
  // controller, so a large batch forwarded one-at-a-time was pure serial latency.
  const POOL = 6;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, accepted.length) }, async () => {
    for (let i = next++; i < accepted.length; i = next++) {
      const f = accepted[i];
      const rel = f.name; // path relative to the folder, e.g. "sub/a.txt"
      const slash = rel.lastIndexOf("/");
      const dir = slash >= 0 ? `${name}/${rel.slice(0, slash)}` : name;
      const filename = slash >= 0 ? rel.slice(slash + 1) : rel;
      await uploadFile(key, dir, new File([f], filename), userId);
    }
  }));
  return Response.json({ ok: true, count: accepted.length });
});
