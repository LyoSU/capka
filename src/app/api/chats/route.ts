import { eq, gt, desc, and, ilike, isNull, inArray, exists, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages, tasks, projects } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";

const createChatSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  projectId: z.string().optional(),
});

// Page size for the sidebar's keyset pagination. The huge "load everything at
// once" list is replaced by pages the sidebar pulls in on scroll.
const PAGE_SIZE = 30;

// The keyset cursor is the last row's (pinned, ts, id) — the exact tuple the
// list is ordered by — so the next page resumes right after it with no offset
// drift when chats are inserted/reordered between pages. `ts` is the DB's own
// to_char rendering of updatedAt (not a JS Date round-trip), so the comparison
// is byte-for-byte consistent and immune to the node-postgres timezone parsing
// of `timestamp` columns.
type Cursor = { pinned: boolean; ts: string; id: string };

// Fixed-width, zero-padded, lexicographically-sortable rendering of updatedAt.
// Both the cursor value and the comparison use this exact expression, so string
// ordering matches timestamp ordering regardless of the process timezone.
const tsExpr = sql<string>`to_char(coalesce(${chats.updatedAt}, 'epoch'::timestamp), 'YYYY-MM-DD HH24:MI:SS.US')`;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (typeof c?.id === "string" && typeof c?.ts === "string" && typeof c?.pinned === "boolean") return c;
  } catch { /* malformed cursor — treat as no cursor */ }
  return null;
}

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search");
  const archived = searchParams.get("archived");
  const pinned = searchParams.get("pinned");
  const projectId = searchParams.get("projectId");

  const conditions: SQL[] = [eq(chats.userId, userId)];

  if (search) conditions.push(ilike(chats.title, `%${search}%`));
  if (archived === "true") conditions.push(eq(chats.archived, true));
  else if (archived !== "all") conditions.push(eq(chats.archived, false));
  if (pinned === "true") conditions.push(eq(chats.pinned, true));
  else if (pinned === "false") conditions.push(eq(chats.pinned, false));
  if (projectId === "none") conditions.push(isNull(chats.projectId));
  else if (projectId) conditions.push(eq(chats.projectId, projectId));

  // Keyset pagination on the (pinned DESC, updatedAt DESC, id DESC) ordering.
  // Postgres row-comparison does lexicographic ordering, so "rows after the
  // cursor" in a fully-DESC ordering is exactly the tuple being strictly less
  // than the cursor's. COALESCE guards the nullable pinned/updatedAt columns so
  // a null can't break the comparison.
  const cursor = decodeCursor(searchParams.get("cursor") ?? "");
  if (cursor) {
    conditions.push(
      sql`(coalesce(${chats.pinned}, false), ${tsExpr}, ${chats.id}) < (${cursor.pinned}::boolean, ${cursor.ts}::text, ${cursor.id}::text)`,
    );
  }

  const rows = await db
    .select({
      id: chats.id,
      title: chats.title,
      pinned: chats.pinned,
      archived: chats.archived,
      projectId: chats.projectId,
      source: chats.source,
      visibility: chats.visibility,
      shareToken: chats.shareToken,
      updatedAt: chats.updatedAt,
      // Unread = an assistant reply landed since the owner last opened the chat
      // (or it was never opened). Powers the sidebar's unread dot; the EXISTS is
      // a cheap probe on the messages(chat_id, created_at) index.
      //
      // Built with the query builder rather than a raw sql`EXISTS(...)`:
      // `eq(messages.chatId, chats.id)` emits a fully-qualified `"chats"."id"`
      // that correlates to the outer row. (A raw sql`${chats.id}` in a
      // select-list renders the column UNqualified, which a correlated subquery
      // silently binds to its own `messages.id` — making it always false.)
      unread: exists(
        db
          .select({ one: sql`1` })
          .from(messages)
          .where(
            and(
              eq(messages.chatId, chats.id),
              eq(messages.role, "assistant"),
              gt(messages.createdAt, sql`COALESCE(${chats.lastReadAt}, 'epoch'::timestamp)`),
            ),
          ),
      ),
      // Running = a task is queued or generating for this chat right now. Seeds
      // the "model working" spinner; SSE keeps it live thereafter.
      running: exists(
        db
          .select({ one: sql`1` })
          .from(tasks)
          .where(and(eq(tasks.chatId, chats.id), inArray(tasks.status, ["queued", "running"]))),
      ),
      // Internal: the canonical updatedAt string the cursor is built from.
      // Stripped from the response body below — never shipped to the client.
      cursorTs: tsExpr,
    })
    .from(chats)
    .where(and(...conditions))
    .orderBy(desc(chats.pinned), desc(chats.updatedAt), desc(chats.id))
    .limit(PAGE_SIZE);

  // A full page implies there may be more; hand back the cursor for the next.
  // The bare array body stays backward-compatible for non-paginating callers
  // (recent-chats, archived) — only the sidebar reads the header.
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === PAGE_SIZE && last
      ? encodeCursor({ pinned: last.pinned ?? false, ts: last.cursorTs, id: last.id })
      : null;

  // Drop the internal cursor field from each row before responding.
  const body = rows.map((row) => {
    const { cursorTs, ...rest } = row;
    void cursorTs; // internal pagination field — never shipped to the client
    return rest;
  });

  return Response.json(body, {
    headers: nextCursor ? { "X-Next-Cursor": nextCursor } : undefined,
  });
});

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const body = createChatSchema.parse(await req.json());

  // A project id must belong to the caller — otherwise a user could attach their
  // chat to someone else's project and inherit its sandbox workspace / system
  // prompt / egress mode. /api/chat validates this; this route must match it.
  if (body.projectId) await requireOwned(projects, body.projectId, userId, "Project");

  const id = body.id || nanoid();
  await db.insert(chats).values({
    id,
    userId,
    title: body.title || "New Chat",
    model: body.model,
    projectId: body.projectId,
  }).onConflictDoNothing();

  return Response.json({ id }, { status: 201 });
});
