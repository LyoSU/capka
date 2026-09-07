import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, projects } from "@/lib/db/schema";
import { projectNotDeleted } from "@/lib/projects/live";

// Two chars is the floor: one letter matches most of a transcript, and the
// substring lane would scan every message to say so.
const MIN_QUERY = 2;
const MAX_QUERY = 200;

// The chats group mirrors what the palette already showed for a title match.
const CHAT_LIMIT = 8;
const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 50;

// How deep each lane goes before the per-chat cap and the final limit apply.
// Deeper than the answer, so a chat that dominates one lane cannot crowd every
// other chat out of the merged set before `row_number` trims it.
const LANE_DEPTH = 200;

// At most this many hits from any one chat, so a single long conversation can't
// fill the group and hide the other chats that matched too.
const PER_CHAT_LIMIT = 3;

/** A LIKE pattern matching `q` literally: the user's `%`, `_` and `\` are their
 *  own characters, not wildcards. Backslash is Postgres' default LIKE escape. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

type MessageHitRow = {
  message_id: string;
  chat_id: string;
  chat_title: string | null;
  role: string;
  created_at: Date;
  snippet: string;
};

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const archived = searchParams.get("archived") === "true";
  const limit = Math.min(
    MAX_MESSAGE_LIMIT,
    Math.max(1, Number(searchParams.get("limit")) || DEFAULT_MESSAGE_LIMIT),
  );

  // Below the floor there is nothing to answer, and answering costs a full scan.
  if (q.length < MIN_QUERY) return Response.json({ chats: [], messages: [] });

  const like = likePattern(q);
  // Both groups are scoped identically, so a message hit can never name a chat
  // the caller could not also have found by its title.
  const conditions: SQL[] = [eq(chats.userId, userId)];
  if (!archived) conditions.push(eq(chats.archived, false));
  // The same conditions, embedded in the raw statement below — which is why the
  // `chats` table is joined UNALIASED there: these render as `"chats"."user_id"`.
  const scope = and(...conditions) as SQL;

  const chatRows = await db
    .select({
      id: chats.id,
      title: chats.title,
      projectName: projects.name,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .leftJoin(projects, and(eq(chats.projectId, projects.id), projectNotDeleted))
    .where(and(scope, ilike(chats.title, like)))
    .orderBy(desc(chats.updatedAt), desc(chats.id))
    .limit(CHAT_LIMIT);

  // Two lanes, not one OR'd predicate: the lexical lane's WHERE is exactly
  // `to_tsvector('simple', content) @@ websearch_to_tsquery('simple', $q)`, the
  // expression `idx_messages_content_fts` indexes, character for character.
  // OR-ing `ilike` into it would force a sequential scan for both halves.
  //
  // The substring lane is not there for a rare case: 'simple' has no stemmer for
  // any language, so half a typed word matches nothing lexically while a person
  // plainly expects it to. `lane` orders the merged set, so a whole-word match
  // always sorts above a substring-only one.
  const hits = await db.execute(sql`
    with recursive tsq as (select websearch_to_tsquery('simple', ${q}) as q),
    lex as (
      select m.id, m.chat_id, 1 as lane,
             ts_rank_cd(to_tsvector('simple', m.content), tsq.q) as rank
      from messages m
      join chats on chats.id = m.chat_id
      cross join tsq
      where ${scope}
        and m.role in ('user', 'assistant')
        and to_tsvector('simple', m.content) @@ tsq.q
      order by rank desc, m.created_at desc
      limit ${LANE_DEPTH}
    ),
    -- How many rows the indexed lane alone will actually SHOW. Trimmed exactly
    -- the way the answer trims, and that is exact rather than approximate:
    -- the "ranked" CTE below orders by lane first, so a lexical hit's row_number does
    -- not depend on whether the substring lane ran.
    lex_answer as (
      select count(*) as n from (
        select row_number() over (partition by chat_id order by rank desc, id) as rn from lex
      ) t where rn <= ${PER_CHAT_LIMIT}
    ),
    sub as (
      select m.id, m.chat_id, 2 as lane, 0::float4 as rank
      from messages m
      join chats on chats.id = m.chat_id
      where ${scope}
        and m.role in ('user', 'assistant')
        -- The one predicate in this statement no index can serve, so it does not
        -- run when it cannot change the answer: lane 1 sorts ahead of lane 2, so
        -- once the lexical lane alone fills the answer limit rows a substring-only hit
        -- could never have been shown. Whole words and phrases — every query a
        -- person finishes typing — are therefore answered from
        -- idx_messages_content_fts alone.
        --
        -- The trade-off, stated plainly: a PARTIAL word still matches no lexeme,
        -- so the lexical lane comes up empty and this scans the caller's messages
        -- (bounded by their chat scope and LANE_DEPTH, and it is why the lane
        -- exists at all — 'simple' has no stemmer). Making that case indexed
        -- needs the pg_trgm extension and a gin (content gin_trgm_ops) index,
        -- i.e. a migration.
        --
        -- Counted before the active-path filter below, which is the one place
        -- this gate is approximate: a caller whose lexical hits are mostly on
        -- abandoned branches can get a short answer where the substring lane
        -- would have filled it. Deliberate — counting after the filter would put
        -- the walk before the lane it is walking for.
        and (select n from lex_answer) < ${limit}
        and m.content ilike ${like}
      order by m.created_at desc
      limit ${LANE_DEPTH}
    ),
    merged as (
      select id, chat_id, min(lane) as lane, max(rank) as rank
      from (select * from lex union all select * from sub) u
      group by id, chat_id
    ),
    -- Only messages on the VISIBLE conversation may be answered. Editing or
    -- regenerating inserts a sibling and moves the chat's leaf; nothing is
    -- deleted, so an abandoned branch keeps matching this search forever — while
    -- the chat API serves only the active path, so the palette would open a
    -- conversation that does not contain the message the user clicked.
    --
    -- The active path is a pointer chain, not a flag (see activePath in
    -- lib/chat/tree.ts): chats.active_leaf_id up through parent_id. Walked
    -- only for the chats that matched, and only back to the oldest candidate in
    -- each — a parent is always older than its child, so nothing above that floor
    -- can be an ancestor of a candidate.
    oldest as (
      select mg.chat_id, min(coalesce(m.created_at, '-infinity'::timestamp)) as at
      from merged mg join messages m on m.id = mg.id
      group by mg.chat_id
    ),
    active as (
      select m.id, m.chat_id, m.parent_id, m.created_at
      from chats
      join oldest o on o.chat_id = chats.id
      join messages m on m.id = chats.active_leaf_id
      union all
      select p.id, p.chat_id, p.parent_id, p.created_at
      from active a
      join messages p on p.id = a.parent_id
      join oldest o on o.chat_id = p.chat_id
      where coalesce(p.created_at, '-infinity'::timestamp) >= o.at
    ),
    visible as (
      select mg.* from merged mg
      where exists (select 1 from active av where av.id = mg.id)
        -- A chat with no leaf pinned (active_leaf_id is NULL, which is also what
        -- deleting the pinned message leaves behind) has no chain to walk, and
        -- activePath falls back to its newest branch. Filtering every hit out of
        -- such a chat would hide messages that ARE reachable, so nothing is
        -- filtered there.
        or not exists (select 1 from active av where av.chat_id = mg.chat_id)
    ),
    ranked as (
      select id, chat_id, lane, rank,
             row_number() over (partition by chat_id order by lane, rank desc, id) as rn
      from visible
    )
    select r.id as message_id, m.chat_id, chats.title as chat_title, m.role, m.created_at,
           -- One line, never a paragraph: the palette row is a single line, so a
           -- snippet carrying newlines would either grow the row or get clipped
           -- by the browser mid-thought instead of by us.
           regexp_replace(trim(case
             when r.lane = 1
               then ts_headline('simple', m.content, tsq.q,
                      'MaxWords=18, MinWords=8, StartSel=<<, StopSel=>>')
             -- A substring-only hit gets the same shape by hand — a window around
             -- the first occurrence with the match marked — so the palette has one
             -- kind of string to highlight, whichever lane found the message.
             when sp.p > 0
               then substr(m.content, greatest(1, sp.p - 50), sp.p - greatest(1, sp.p - 50))
                    || '<<' || substr(m.content, sp.p, length(${q})) || '>>'
                    || substr(m.content, sp.p + length(${q}), 60)
             else left(m.content, 120)
           end), '\\s+', ' ', 'g') as snippet
    from ranked r
    join messages m on m.id = r.id
    join chats on chats.id = m.chat_id
    cross join tsq
    cross join lateral (select strpos(lower(m.content), lower(${q})) as p) sp
    where r.rn <= ${PER_CHAT_LIMIT}
    order by r.lane, r.rank desc, m.created_at desc
    limit ${limit}
  `);

  return Response.json({
    chats: chatRows,
    messages: (hits.rows as MessageHitRow[]).map((r) => ({
      messageId: r.message_id,
      chatId: r.chat_id,
      chatTitle: r.chat_title,
      role: r.role,
      createdAt: r.created_at,
      snippet: r.snippet,
    })),
  });
});
