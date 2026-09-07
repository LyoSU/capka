import { eq, gt, desc, and, ilike, isNull, inArray, exists, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, messages, tasks, projects } from "@/lib/db/schema";
import { projectNotDeleted, requireLiveProject } from "@/lib/projects/live";

const createChatSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  projectId: z.string().optional(),
});

// Page size for the sidebar's keyset pagination. The huge "load everything at
// once" list is replaced by pages the sidebar pulls in on scroll.
const PAGE_SIZE = 30;

// Cap for the unpaginated `attention=true` bucket. A person with 50 chats each
// stopped on a question is already past the point where a list helps, so the
// cap is a bound on the query, not a page the caller is meant to walk.
const ATTENTION_LIMIT = 50;

// Why a chat is stopped waiting for a person, derived from its last message.
type AttentionKind = "approval" | "ask" | "failed";

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
  // The sidebar's "needs you" group asks for the whole set in one go: the list
  // is paginated, so a chat that stopped for a person can sit pages down and
  // would simply never be seen. Unpaginated and capped instead.
  const attentionOnly = searchParams.get("attention") === "true";

  // The chat's LAST message, which is where "this chat is waiting for a person"
  // is read from. Derived, never stored: the moment the user answers, their
  // message is the last one and the state clears itself with no write anywhere.
  //
  // A LEFT JOIN LATERAL rather than a per-row lookup — one backwards scan of the
  // messages(chat_id, created_at) index per chat, no N+1. Built with the query
  // builder for the same reason as `unread` below: `eq(messages.chatId,
  // chats.id)` emits a qualified `"chats"."id"` that correlates to the outer
  // row, where a raw sql`${chats.id}` would render bare and silently bind to the
  // subquery's own column.
  const lastMessage = db
    .select({
      attentionKind: sql<AttentionKind | null>`case when ${messages.role} = 'assistant' then
          case ${messages.metadata}->>'status'
            when 'awaiting_approval' then 'approval'
            when 'awaiting_answer' then 'ask'
            when 'failed' then 'failed'
          end
        end`.as("attention_kind"),
      attentionSince: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.chatId, chats.id))
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .as("last_message");

  // A failure asks to be SEEN, not answered: the error card is already in the
  // chat, and there is nothing to decide. So, unlike approval/ask (which block
  // until the person acts), `failed` follows the same rule as `unread` — it leaves
  // the bucket once the chat has been opened after the failure. Without this, every
  // chat that ever failed would sit in "needs you" forever with no way out.
  const attentionKind = sql<AttentionKind | null>`case
      when ${lastMessage.attentionKind} = 'failed'
       and coalesce(${chats.lastReadAt}, 'epoch'::timestamp) >= ${lastMessage.attentionSince}
      then null
      else ${lastMessage.attentionKind}
    end`;

  const conditions: SQL[] = [eq(chats.userId, userId)];

  if (search) conditions.push(ilike(chats.title, `%${search}%`));
  if (archived === "true") conditions.push(eq(chats.archived, true));
  else if (archived !== "all") conditions.push(eq(chats.archived, false));
  if (pinned === "true") conditions.push(eq(chats.pinned, true));
  else if (pinned === "false") conditions.push(eq(chats.pinned, false));
  if (projectId === "none") conditions.push(isNull(chats.projectId));
  else if (projectId) conditions.push(eq(chats.projectId, projectId));

  if (attentionOnly) conditions.push(sql`${attentionKind} is not null`);

  // Keyset pagination on the (pinned DESC, updatedAt DESC, id DESC) ordering.
  // Postgres row-comparison does lexicographic ordering, so "rows after the
  // cursor" in a fully-DESC ordering is exactly the tuple being strictly less
  // than the cursor's. COALESCE guards the nullable pinned/updatedAt columns so
  // a null can't break the comparison. The bucket is a whole set rather than a
  // page, so it ignores the cursor entirely.
  const cursor = attentionOnly ? null : decodeCursor(searchParams.get("cursor") ?? "");
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
      // The owning project's name (LEFT JOIN — null for project-less chats), so the
      // sidebar can badge a chat with its project without a second projects fetch.
      // A dedicated join (not a client-side map of the top-N projects) is required:
      // an old chat's project may be well outside the sidebar's recent list.
      projectName: projects.name,
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
      // Folded into the `attention` object below.
      attentionKind,
      attentionSince: lastMessage.attentionSince,
      // Internal: the canonical updatedAt string the cursor is built from.
      // Stripped from the response body below — never shipped to the client.
      cursorTs: tsExpr,
    })
    .from(chats)
    // Tombstoned projects are excluded from the join, so a chat mid-deletion of its
    // project shows no (stale) badge — it reads as project-less until teardown resets it.
    .leftJoin(projects, and(eq(chats.projectId, projects.id), projectNotDeleted))
    .leftJoinLateral(lastMessage, sql`true`)
    .where(and(...conditions))
    .orderBy(desc(chats.pinned), desc(chats.updatedAt), desc(chats.id))
    .limit(attentionOnly ? ATTENTION_LIMIT : PAGE_SIZE);

  // A full page implies there may be more; hand back the cursor for the next.
  // The bare array body stays backward-compatible for non-paginating callers
  // (recent-chats, archived) — only the sidebar reads the header.
  const last = rows[rows.length - 1];
  const nextCursor =
    !attentionOnly && rows.length === PAGE_SIZE && last
      ? encodeCursor({ pinned: last.pinned ?? false, ts: last.cursorTs, id: last.id })
      : null;

  // Drop the internal cursor field from each row before responding.
  const body = rows.map((row) => {
    const { cursorTs, attentionKind, attentionSince, ...rest } = row;
    void cursorTs; // internal pagination field — never shipped to the client
    return {
      ...rest,
      attention:
        attentionKind && attentionSince
          ? { kind: attentionKind, since: attentionSince.toISOString() }
          : null,
    };
  });

  return Response.json(body, {
    headers: nextCursor ? { "X-Next-Cursor": nextCursor } : undefined,
  });
});

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const body = createChatSchema.parse(await req.json());

  // A project id must belong to the caller AND still be live — otherwise a user
  // could attach their chat to someone else's (or a tombstoned) project and inherit
  // its sandbox workspace / system prompt / egress mode. /api/chat matches this.
  if (body.projectId) await requireLiveProject(body.projectId, userId);

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
