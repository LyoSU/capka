import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { memoryDocs, noteClaims, vaultClaims, vaultNotes } from "@/lib/db/schema";
import { listHeadClaims } from "./claims";

/** «Кап 4КБ» із брифу — орієнтовна цифра для тимчасового (до Task 10 cutover)
 *  сирого тексту, не контракт на точний байт. Побайтова обрізка UTF-8 тут
 *  коштувала б складності, якої цей рядок не переживе довше одного релізу. */
const LEGACY_CAP_CHARS = 4096;

/** До 10 голів на секцію: reviewStatus фільтрує SQL (`onlyConfirmed`), sensitive —
 *  тут, бо в `listHeadClaims` такого опційного фільтра немає (і не мусить бути —
 *  він служить і Task 7 тулам, яким чутливі клейми потрібні). Порядок голів
 *  (`recorded_at DESC, id`) фільтр не міняє, тож top-10 після фільтра лишається
 *  тим самим top-10 «якби фільтр стояв у SQL». */
async function recentFacts(spaceId: string): Promise<string[]> {
  const heads = await listHeadClaims(spaceId, { onlyConfirmed: true });
  return heads
    .filter((h) => !h.sensitive)
    .slice(0, 10)
    .map((h) => h.statement);
}

/** Лічильник на тему — ЛИШЕ confirmed non-sensitive голови: маніфест — це те, на
 *  що агент може покластись, і число поруч із назвою теми виказало б, що щось
 *  відоме, навіть коли жоден із цих фактів іще не показаний ніде в тексті.
 *  `LEFT JOIN` на нотах, а не `INNER`, — тема без жодного відповідного клейма
 *  мусить лишитись у списку з 0, а не зникнути (вона й так рідко трапляється в
 *  плані A, де все йде в «Загальне», але зникнення теми було б сюрпризом). */
async function topicCounts(spaceId: string): Promise<{ title: string; count: number }[]> {
  const rows = await db
    .select({
      title: vaultNotes.title,
      count: sql<number>`count(${vaultClaims.id})::int`,
    })
    .from(vaultNotes)
    .leftJoin(noteClaims, eq(noteClaims.noteId, vaultNotes.id))
    .leftJoin(
      vaultClaims,
      and(
        eq(vaultClaims.id, noteClaims.claimId),
        isNull(vaultClaims.supersededAt),
        eq(vaultClaims.reviewStatus, "confirmed"),
        eq(vaultClaims.sensitive, false),
      ),
    )
    .where(and(eq(vaultNotes.spaceId, spaceId), eq(vaultNotes.kind, "memory_topic")))
    .groupBy(vaultNotes.id, vaultNotes.title)
    // Порядок мусить бути детермінованим (байт-у-байт вимога): `id` (nanoid) як
    // єдиний доступний тут стабільний ключ — `createdAt` не завжди різниться на
    // мілісекунду між темами, вставленими в одній транзакції.
    .orderBy(asc(vaultNotes.id));
  return rows;
}

function spaceBlock(header: string, topics: { title: string; count: number }[], facts: string[]): string {
  const lines = [header];
  if (topics.length) lines.push("", "Теми:", ...topics.map((t) => `- ${t.title} — ${t.count} фактів`));
  if (facts.length) lines.push("", "Останні факти:", ...facts.map((s) => `- ${s}`));
  return lines.join("\n");
}

/** Legacy-документ (до Task 6/10 cutover) для скопу user (`projectId: null`) чи
 *  проєкту. `memory_docs` ключується `(userId, projectId)`, НЕ spaceId — той самий
 *  запит, що й старий `readMemoryDocs` (`src/lib/memory/store.ts`). Повертає
 *  `null`, коли рядка немає, він уже мігрований, чи його вміст порожній —
 *  порожній fallback не вартий рядка в промпті. */
async function legacyDoc(userId: string, projectId: string | null): Promise<string | null> {
  const [row] = await db
    .select({ content: memoryDocs.content })
    .from(memoryDocs)
    .where(
      and(
        eq(memoryDocs.userId, userId),
        projectId ? eq(memoryDocs.projectId, projectId) : isNull(memoryDocs.projectId),
        isNull(memoryDocs.migratedAt),
      ),
    )
    .limit(1);
  if (!row || !row.content.trim()) return null;
  return row.content.length > LEGACY_CAP_CHARS ? row.content.slice(0, LEGACY_CAP_CHARS) : row.content;
}

/**
 * Маніфест пам'яті на промпт: два простори (користувач, і проєкт — якщо колер
 * його передав), плюс fallback на legacy `memory_docs`, поки Task 6 не
 * домігрував їх. Кожен рядок тут читає модель, а не людина — жодного слова про
 * `search_knowledge` (тула ще нема, рядок додає план C).
 *
 * `userId`/`projectId` окремо від `userSpaceId`/`projectSpaceId` — не
 * дублювання: fallback ключується (userId, projectId), простори — spaceId,
 * і одне з іншого не виводиться.
 */
export async function buildMemoryManifest(args: {
  userId: string;
  userSpaceId: string;
  projectId?: string;
  projectSpaceId?: string;
}): Promise<string> {
  const blocks: string[] = [];

  const [userTopics, userFacts] = await Promise.all([
    topicCounts(args.userSpaceId),
    recentFacts(args.userSpaceId),
  ]);
  blocks.push(spaceBlock("## Пам'ять про користувача", userTopics, userFacts));

  if (args.projectSpaceId) {
    const [projectTopics, projectFacts] = await Promise.all([
      topicCounts(args.projectSpaceId),
      recentFacts(args.projectSpaceId),
    ]);
    blocks.push(spaceBlock("## Пам'ять проєкту", projectTopics, projectFacts));
  }

  // Обидві половини незалежні: проєкт може бути вже мігрований, а
  // користувацький doc — ще ні (чи навпаки).
  const legacyEntries: { label: string; content: string }[] = [];
  const userLegacy = await legacyDoc(args.userId, null);
  if (userLegacy) legacyEntries.push({ label: "Користувач", content: userLegacy });
  if (args.projectId) {
    const projectLegacy = await legacyDoc(args.userId, args.projectId);
    if (projectLegacy) legacyEntries.push({ label: "Проєкт", content: projectLegacy });
  }
  if (legacyEntries.length) {
    const lines = ["## Пам'ять (мігрується)"];
    for (const e of legacyEntries) lines.push("", `${e.label}:`, e.content);
    blocks.push(lines.join("\n"));
  }

  blocks.push(
    "Use memory_search before assuming facts about the user or project; propose new facts with memory_propose.",
  );

  return blocks.join("\n\n");
}
