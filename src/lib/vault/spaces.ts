import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  auditEvents,
  knowledgeSources,
  memoryCandidates,
  spaces,
  vaultClaims,
  vaultNotes,
} from "@/lib/db/schema";

/** Хендл БД: пул або транзакція колера. Кожна функція тут ВСІ свої стейтменти
 *  шле через нього — тихий відкат на модульний `db` усередині чужої транзакції
 *  зламав би атомарність так, що жоден тест цього не побачив би. */
export type Ex = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Простір знань для власника: user-простір на користувача, project-простір на
 *  проєкт (чати проєкту ділять один). `ownerUserId` для user-простору = refId;
 *  для проєкту його передає колер — у нього рядок проєкту вже в руках, а зайвий
 *  SELECT тут сидів би на гарячому шляху ходу. */
export async function getOrCreateSpace(
  scope: { type: "user"; refId: string } | { type: "project"; refId: string; ownerUserId: string },
  ex: Ex = db,
): Promise<string> {
  const where = and(eq(spaces.type, scope.type), eq(spaces.refId, scope.refId));
  const found = await ex.select({ id: spaces.id }).from(spaces).where(where).limit(1);
  if (found[0]) return found[0].id;
  // Перші паралельні записи змагаються за uniq_spaces_type_ref; хто програв —
  // мовчки нічого не пише і дочитує рядок переможця.
  await ex
    .insert(spaces)
    .values({
      id: nanoid(),
      type: scope.type,
      refId: scope.refId,
      ownerUserId: scope.type === "user" ? scope.refId : scope.ownerUserId,
    })
    .onConflictDoNothing();
  const [row] = await ex.select({ id: spaces.id }).from(spaces).where(where).limit(1);
  if (!row) throw new Error(`space ${scope.type}:${scope.refId} vanished after insert`);
  return row.id;
}

/** Тема пам'яті — нота виду `memory_topic`; саме на цьому виді висить
 *  партіальний unique (space, title), тож та сама гонка й та сама розв'язка. */
export async function getOrCreateTopicNote(spaceId: string, title: string, ex: Ex = db): Promise<string> {
  const where = and(eq(vaultNotes.spaceId, spaceId), eq(vaultNotes.title, title), eq(vaultNotes.kind, "memory_topic"));
  const found = await ex.select({ id: vaultNotes.id }).from(vaultNotes).where(where).limit(1);
  if (found[0]) return found[0].id;
  await ex.insert(vaultNotes).values({ id: nanoid(), spaceId, title, kind: "memory_topic" }).onConflictDoNothing();
  const [row] = await ex.select({ id: vaultNotes.id }).from(vaultNotes).where(where).limit(1);
  if (!row) throw new Error(`memory topic "${title}" vanished after insert`);
  return row.id;
}

/** Проєкт видаляють — його ПАМ'ЯТЬ вмирає з ним (клейми, теми, кандидати), а
 *  ЗНАННЯ лишаються: `chats.projectId` — SET NULL, тож чати переживають проєкт і
 *  їхні цитати й далі пінять версії. Тому джерела гасяться soft-delete, а
 *  версії/фрагменти/цитати не чіпаються. Рядок простору теж лишається — його
 *  знесе purge за owner_user_id (повний GC — план D).
 *
 *  Ідемпотентний, бо teardown передрайвлюється з worker-тіка: подія `space.retire`
 *  пишеться рівно раз на простір. */
export async function retireProjectSpace(projectId: string, ex?: Ex): Promise<void> {
  if (!ex) return db.transaction((tx) => retireProjectSpace(projectId, tx));

  const [space] = await ex
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.type, "project"), eq(spaces.refId, projectId)))
    .limit(1)
    // Блокуємо рядок простору на час транзакції: «події ще немає» — це
    // read-modify-write, і без цього два одночасні retire (запит і worker-тік,
    // якщо перший переповз 30-секундний grace) обидва прочитали б «немає» і
    // записали б по події. Стара умова «було що зносити» була race-safe
    // випадково — одна з транзакцій нічого б не видалила.
    .for("update");
  if (!space) return;
  const spaceId = space.id;

  // note_claims і claim_evidence йдуть каскадом за нотами/клеймами.
  const claims = await ex.delete(vaultClaims).where(eq(vaultClaims.spaceId, spaceId)).returning({ id: vaultClaims.id });
  const notes = await ex.delete(vaultNotes).where(eq(vaultNotes.spaceId, spaceId)).returning({ id: vaultNotes.id });
  const candidates = await ex
    .delete(memoryCandidates)
    .where(eq(memoryCandidates.spaceId, spaceId))
    .returning({ id: memoryCandidates.id });
  const sources = await ex
    .update(knowledgeSources)
    .set({ deletedAt: new Date() })
    .where(and(eq(knowledgeSources.spaceId, spaceId), isNull(knowledgeSources.deletedAt)))
    .returning({ id: knowledgeSources.id });

  // Рівно одна подія на видалення проєкту — умова саме «події ще немає», а НЕ
  // «було що зносити»: простір, який користувач почистив руками, теж мусить
  // лишити слід, інакше «події немає» читається однаково як «простір був
  // порожній» і як «teardown не доїхав», а з retryPendingProjectTeardowns це
  // жива операційна різниця. Лукап іде по idx_audit_space_created.
  const [priorEvent] = await ex
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.spaceId, spaceId), eq(auditEvents.action, "space.retire")))
    .limit(1);
  if (priorEvent) return;
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId,
    actor: { kind: "system" },
    action: "space.retire",
    subjectType: "space",
    subjectId: spaceId,
    payload: {
      projectId,
      claims: claims.length,
      notes: notes.length,
      candidates: candidates.length,
      sources: sources.length,
    },
  });
}

/** Знання видаленого користувача не переживають його. Викликається В ОДНІЙ
 *  транзакції з `db.delete(users)` і ПІСЛЯ нього: каскад users на той момент уже
 *  зніс чати → повідомлення → цитати, тож пінів не лишилось і каскад просторів
 *  проходить наскрізь. `owner_user_id` денормалізований саме заради цього — він
 *  знаходить і простори ДАВНО видалених проєктів, чиїх рядків уже немає.
 *  Жива цитата (аномалія) кине RESTRICT і відкотить УСЮ транзакцію: користувач
 *  лишиться на місці, адмін побачить помилку й повторить — атомарно за
 *  побудовою, окремий retry не потрібен. */
export async function purgeUserSpaces(userId: string, ex: Ex = db): Promise<void> {
  await ex.delete(spaces).where(eq(spaces.ownerUserId, userId));
}
