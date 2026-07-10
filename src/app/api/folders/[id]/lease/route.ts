import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiHandler, requireActive } from "@/lib/auth";
import { db, pool } from "@/lib/db";
import { attachedFolders } from "@/lib/db/schema";

// Server-side sync lease for a PC folder. The merge-ancestor CAS in
// /[id]/state only protects the manifest row, not the files a sync already
// mutated — so two tabs / project members syncing the same folder could both
// upload/delete against it at once. Acquiring this lease first gives the whole
// sync span mutual exclusion; it self-expires so a client that dies mid-sync
// never locks the folder for good.

// Generous enough for a large folder's hash + upload pass; a sync that outlives
// it simply risks a second one starting (the union merge stays safe).
const LEASE_MS = 10 * 60 * 1000;

async function ownedFolderId(id: string, userId: string, role: string): Promise<boolean> {
  const [row] = await db.select({ userId: attachedFolders.userId }).from(attachedFolders).where(eq(attachedFolders.id, id)).limit(1);
  return !!row && (row.userId === userId || role === "admin");
}

// Acquire — 200 { token } if free (or the prior lease expired), 409 if another
// sync holds it, 404 if the folder isn't the caller's.
export const POST = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId, role } = await requireActive();
  const { id } = await params;
  if (!(await ownedFolderId(id, userId, role))) return Response.json({ error: "Not found" }, { status: 404 });

  const token = nanoid();
  const expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  // Atomic take-or-fail: claim only when no live lease exists. Raw query so the
  // jsonb expiry compares in-DB (no read-modify-write race between tabs).
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE attached_folders
        SET sync_lease = $2::jsonb, updated_at = now()
      WHERE id = $1
        AND (sync_lease IS NULL OR (sync_lease->>'expiresAt')::timestamptz < now())
      RETURNING id`,
    [id, JSON.stringify({ token, expiresAt })],
  );
  if (!rows[0]) return Response.json({ error: "Folder is syncing elsewhere." }, { status: 409 });
  return Response.json({ token, expiresAt });
});

// Release — clears the lease only if the caller still holds THIS token, so a
// sync that overran its expiry (and was superseded) can't wipe the new holder's.
export const DELETE = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId, role } = await requireActive();
  const { id } = await params;
  if (!(await ownedFolderId(id, userId, role))) return Response.json({ error: "Not found" }, { status: 404 });
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return Response.json({ error: "token required" }, { status: 400 });
  await pool.query(
    `UPDATE attached_folders SET sync_lease = NULL, updated_at = now()
      WHERE id = $1 AND sync_lease->>'token' = $2`,
    [id, token],
  );
  return Response.json({ ok: true });
});
