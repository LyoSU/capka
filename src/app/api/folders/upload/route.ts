import { apiHandler, requireActive } from "@/lib/auth";
import { pool } from "@/lib/db";
import { heldByOtherSql } from "@/lib/folders/lease";
import { uploadFile } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget } from "@/lib/sandbox/target";
import { take } from "@/lib/rate-limit";
import { pcFolderLevel, canAttachPc } from "@/lib/manage/controls/folders";
import { ignoredPath, oversized } from "@/lib/folder-bridge/filter";

/** Every folder name any version of `sanitizeFolderName` ever produced fits this. */
const FOLDER_NAME = /^[a-z0-9_-]{1,40}$/;
/** A relative file path that starts at the root or has a ".." segment. */
const CLIMBS = /^\/|(^|\/)\.\.(\/|$)/;

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
  // The lease check below looks the folder row up by name, while the controller
  // resolves the write path — so "docs/." would miss the row for "docs" and still land
  // in /workspace/docs, and a file named "../docs2/a.txt" would land in docs2. Both
  // halves of the path are therefore held to the stored charset: the name has never
  // been allowed a "/" or a ".", and a relative file path may not climb. This is a
  // charset test, NOT `name === sanitizeFolderName(name)`: rows attached before the
  // sanitizer learned to collapse separators (a "--" inside, a trailing "-") are
  // canonical for THEIR rule and must keep syncing.
  if (!FOLDER_NAME.test(name)) return Response.json({ error: "Invalid folder name" }, { status: 400 });
  if (files.some((f) => CLIMBS.test(f.name))) return Response.json({ error: "Invalid file path" }, { status: 400 });

  const { sessionKey: key } = await resolveWorkspaceTarget({ userId, chatId, projectId });

  // A sync claims the folder with a lease and holds it for its whole span, but the
  // client alone cannot enforce that: a batch already assembled goes out even if the
  // lease lapsed while its files were being read, and a stale tab's writes were
  // accepted here unconditionally.
  //
  // The question is asked of the FOLDER, never of the request: is this row under a
  // live lease that is not the one named here? Gating on `if (lease)` instead made
  // the fence opt-in — omitting the field skipped the check entirely and wrote into a
  // folder another window was mid-sync on, which is the whole hazard. Asking the row
  // first also keeps the paths that legitimately hold no lease working unchanged: a
  // folder with no row (the one-shot fallback import) and a row whose lease has
  // expired or was released are nobody's, so anyone may write.
  //
  // Checked once per request. A lease that expires between this check and the last
  // file of the batch is not re-checked; the client renews at a fifth of the TTL, so
  // that needs the client to be gone, and the window is one batch. Accepted.
  const { rows: blocked } = await pool.query(
    `SELECT 1 FROM attached_folders WHERE session_key = $1 AND name = $2 AND ${heldByOtherSql(3)}`,
    [key, name, lease],
  );
  if (blocked[0]) {
    return Response.json({ error: "Another window took over syncing this folder.", code: "LEASE_GONE" }, { status: 409 });
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
  let failed = 0;
  const workers = Array.from({ length: Math.min(POOL, accepted.length) }, async () => {
    for (let i = next++; i < accepted.length; i = next++) {
      // Once any worker has failed the batch is over: a controller that just refused
      // a write should not then be handed the ninety files nobody has claimed yet.
      if (failed > 0) return;
      const f = accepted[i];
      const rel = f.name; // path relative to the folder, e.g. "sub/a.txt"
      const slash = rel.lastIndexOf("/");
      const dir = slash >= 0 ? `${name}/${rel.slice(0, slash)}` : name;
      const filename = slash >= 0 ? rel.slice(slash + 1) : rel;
      try {
        await uploadFile(key, dir, new File([f], filename), userId);
      } catch (e) {
        failed++;
        throw e;
      }
    }
  });
  // allSettled, not all: `all` rejects the moment the FIRST worker does, and this
  // handler answering means the client's sync moves on and releases the folder lease
  // in its `finally` — while up to five writes were still in flight and would land
  // under whoever acquired the lease next. Waiting for every worker to settle makes
  // the response the true end of this request's writes.
  const settled = await Promise.allSettled(workers);
  const broke = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (broke.length > 0) {
    // 500 through apiHandler, which logs the cause. The count is of workers that hit
    // a failure, not of files: each stops at its first one, and the rest of the batch
    // was abandoned deliberately.
    throw new Error(`Could not write ${broke.length} of ${accepted.length} uploaded files to the workspace.`, { cause: broke[0].reason });
  }
  return Response.json({ ok: true, count: accepted.length });
});
