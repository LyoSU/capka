import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, claimEvidence, noteClaims, vaultClaims } from "@/lib/db/schema";
import type { Ex } from "./spaces";

export type Actor = { kind: "user" | "agent" | "system"; id?: string };

export type ClaimHead = {
  id: string;
  revision: number;
  statement: string;
  slotKey: string | null;
  value: unknown;
  reviewStatus: string;
  sensitive: boolean;
};

export type ClaimInput = {
  spaceId: string;
  statement: string;
  slotKey?: string;
  value?: unknown;
  origin: Record<string, unknown>;
  reviewStatus: "unverified" | "confirmed";
  sensitive?: boolean;
  topicNoteId?: string;
};

export type EvidenceInput = {
  relation?: "supports" | "refutes" | "derived_from";
  fragmentId?: string;
  messageId?: string;
  quoteSnapshot?: string;
  locatorSnapshot?: unknown;
};

/** Рівно поля `ClaimHead` — текст клейма віддається лише тим, хто пройшов
 *  space-фільтр, тож жодного «зайвого» стовпця тут бути не може. */
const HEAD = {
  id: vaultClaims.id,
  revision: vaultClaims.revision,
  statement: vaultClaims.statement,
  slotKey: vaultClaims.slotKey,
  value: vaultClaims.value,
  reviewStatus: vaultClaims.reviewStatus,
  sensitive: vaultClaims.sensitive,
};

/** Ланцюг версій не має циклів — `uniq_vclaims_one_successor` дає щонайбільше
 *  одного наступника, а наступник завжди новіший. Але `while` по даних без межі
 *  — це те, як сервіс зависає, тож межа явна. */
const MAX_CHAIN = 1000;

/** Усі три записувальні ходи (`createClaim`, `updateClaim`, `forgetClaim`)
 *  пишуть по кілька рядків, тож без транзакції це не хід, а кілька окремих
 *  стейтментів. Умова `!ex || ex === db` — не описка: `Ex` дозволяє передати
 *  модульний пул ЯВНО, і тоді «омісія» й «явний db» означали б різне, а
 *  мовчазна втрата атомарності на другому — рівно той дефект, якого не видно
 *  зі звичайного тесту. Передана транзакція, навпаки, лишається чужою: її
 *  межі визначає колер. */
export async function createClaim(
  input: ClaimInput,
  actor: Actor,
  ex?: Ex,
): Promise<{ id: string; revision: number }> {
  if (!ex || ex === db) return db.transaction((tx) => createClaim(input, actor, tx));

  const id = nanoid();
  // Конфлікт слоту (`uniq_vclaims_active_slot`) НЕ ловиться тут: рішення
  // «злити чи розвести» належить реєстру кандидатів, який і тримає SAVEPOINT.
  await ex.insert(vaultClaims).values({
    id,
    spaceId: input.spaceId,
    statement: input.statement,
    slotKey: input.slotKey ?? null,
    value: input.value ?? null,
    origin: input.origin,
    reviewStatus: input.reviewStatus,
    sensitive: input.sensitive ?? false,
  });
  if (input.topicNoteId) await ex.insert(noteClaims).values({ noteId: input.topicNoteId, claimId: id });
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: input.spaceId,
    actor,
    action: "claim.create",
    subjectType: "claim",
    subjectId: id,
    // Без тексту клейма: аудит читають ширше, ніж сам простір знань.
    payload: { slotKey: input.slotKey ?? null, reviewStatus: input.reviewStatus, sensitive: input.sensitive ?? false },
  });
  return { id, revision: 1 };
}

export async function updateClaim(
  args: {
    claimId: string;
    expectedRevision: number;
    patch: { statement?: string; value?: unknown; slotKey?: string };
    allowedSpaceIds: string[];
    actor: Actor;
  },
  ex?: Ex,
): Promise<{ ok: true; id: string; revision: number } | { ok: false; current: ClaimHead | null }> {
  if (!ex || ex === db) return db.transaction((tx) => updateClaim(args, tx));
  const { claimId, expectedRevision, patch, allowedSpaceIds, actor } = args;

  // CAS-крок ПЕРШИЙ: він і бере блокування рядка, і перевіряє ревізію, і
  // перевіряє простір — одним стейтментом, тож між перевіркою й записом немає
  // вікна. Другий одночасний supersede стає в чергу на цьому UPDATE і після
  // коміту переможця перечитує рядок: `superseded_at IS NULL` уже хибне.
  const [prev] = await ex
    .update(vaultClaims)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(vaultClaims.id, claimId),
        eq(vaultClaims.revision, expectedRevision),
        isNull(vaultClaims.supersededAt),
        inArray(vaultClaims.spaceId, allowedSpaceIds),
      ),
    )
    .returning();

  // Нуль рядків — це «не та ревізія» АБО «уже не голова» АБО «не твій простір»,
  // і розрізнити їх ззовні неможливо навмисне: відповідь іде з ТИМ САМИМ
  // space-фільтром, тож `current: null` однаково означає і «ланцюг забуто», і
  // «такого клейма для тебе не існує».
  if (!prev) return { ok: false, current: await findCurrentHead(claimId, allowedSpaceIds, ex) };

  const id = nanoid();
  const revision = prev.revision + 1;
  // Наступник — свіжий рядок, а не UPDATE тексту: попередник лишається дослівно
  // таким, яким його записали. Копіюється весь клейм, а не лише три поля з
  // патча, — інакше `kind`/термін дії тихо скидались би на дефолти схеми.
  //
  // Як і в `createClaim`, конфлікт слоту (`uniq_vclaims_active_slot`) НЕ ловиться
  // тут: `patch.slotKey`, що вказує на зайнятий слот, кине 23505 і відкотить
  // транзакцію колера так само. Реєстр кандидатів мусить тримати SAVEPOINT
  // навколо ОБОХ ходів, а не лише навколо створення.
  await ex.insert(vaultClaims).values({
    id,
    spaceId: prev.spaceId,
    statement: patch.statement ?? prev.statement,
    slotKey: patch.slotKey ?? prev.slotKey,
    value: patch.value !== undefined ? patch.value : prev.value,
    kind: prev.kind,
    origin: prev.origin,
    reviewStatus: prev.reviewStatus,
    sensitive: prev.sensitive,
    validFrom: prev.validFrom,
    validTo: prev.validTo,
    revision,
    supersedes: claimId,
  });
  // Перенос прив'язок одним UPDATE: наступник опиняється в тих самих темах,
  // попередник їх не тримає. Пара insert...select + delete дала б той самий
  // стан двома стейтментами й порядком, який можна переплутати.
  await ex.update(noteClaims).set({ claimId: id }).where(eq(noteClaims.claimId, claimId));
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: prev.spaceId,
    actor,
    action: "claim.supersede",
    subjectType: "claim",
    subjectId: claimId,
    payload: { successor: id, revision },
  });
  return { ok: true, id, revision };
}

export async function forgetClaim(
  args: { claimId: string; expectedRevision: number; allowedSpaceIds: string[]; actor: Actor; reason?: string },
  ex?: Ex,
): Promise<{ ok: true } | { ok: false; current: ClaimHead | null }> {
  if (!ex || ex === db) return db.transaction((tx) => forgetClaim(args, tx));
  const { claimId, expectedRevision, allowedSpaceIds, actor, reason } = args;

  const [prev] = await ex
    .update(vaultClaims)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(vaultClaims.id, claimId),
        eq(vaultClaims.revision, expectedRevision),
        isNull(vaultClaims.supersededAt),
        inArray(vaultClaims.spaceId, allowedSpaceIds),
      ),
    )
    .returning({ spaceId: vaultClaims.spaceId, revision: vaultClaims.revision });
  if (!prev) return { ok: false, current: await findCurrentHead(claimId, allowedSpaceIds, ex) };

  // Наступника немає — «забутий» це ланцюг без активної голови. `note_claims` і
  // `claim_evidence` лишаються на неактивному рядку: забути факт не означає
  // переписати те, звідки він узявся.
  await ex.insert(auditEvents).values({
    id: nanoid(),
    spaceId: prev.spaceId,
    actor,
    action: "claim.forget",
    subjectType: "claim",
    subjectId: claimId,
    payload: { revision: prev.revision, reason: reason ?? null },
  });
  return { ok: true };
}

export async function attachEvidence(claimId: string, ev: EvidenceInput, ex: Ex = db): Promise<void> {
  await ex.insert(claimEvidence).values({
    id: nanoid(),
    claimId,
    relation: ev.relation ?? "supports",
    fragmentId: ev.fragmentId ?? null,
    messageId: ev.messageId ?? null,
    quoteSnapshot: ev.quoteSnapshot ?? null,
    locatorSnapshot: ev.locatorSnapshot ?? null,
  });
}

export async function listHeadClaims(
  spaceId: string,
  opts: { slotKey?: string; topicNoteId?: string; onlyConfirmed?: boolean } = {},
  ex: Ex = db,
): Promise<ClaimHead[]> {
  return ex
    .select(HEAD)
    .from(vaultClaims)
    .where(
      and(
        eq(vaultClaims.spaceId, spaceId),
        isNull(vaultClaims.supersededAt),
        opts.slotKey ? eq(vaultClaims.slotKey, opts.slotKey) : undefined,
        opts.onlyConfirmed ? eq(vaultClaims.reviewStatus, "confirmed") : undefined,
        // Підзапит не виконується окремо — drizzle вбудовує його SQL у цей самий
        // стейтмент, тож він їде тим самим `ex`, що й зовнішній SELECT.
        opts.topicNoteId
          ? inArray(
              vaultClaims.id,
              ex.select({ id: noteClaims.claimId }).from(noteClaims).where(eq(noteClaims.noteId, opts.topicNoteId)),
            )
          : undefined,
      ),
    )
    // Другий ключ не декоративний: `recorded_at` збігається в усіх клеймів, які
    // записала одна транзакція, і без `id` їхній порядок був би довільним.
    .orderBy(desc(vaultClaims.recordedAt), asc(vaultClaims.id));
}

export async function headBySlot(spaceId: string, slotKey: string, ex: Ex = db): Promise<ClaimHead | null> {
  const [row] = await ex
    .select(HEAD)
    .from(vaultClaims)
    .where(
      and(eq(vaultClaims.spaceId, spaceId), eq(vaultClaims.slotKey, slotKey), isNull(vaultClaims.supersededAt)),
    )
    .limit(1);
  return row ?? null;
}

/** Йде ВПЕРЕД по ланцюгу: від заданого клейма за `supersedes` до останнього
 *  рядка. Якщо на ньому стоїть `superseded_at` — ланцюг закінчили forget-ом, і
 *  голови немає. `allowedSpaceIds` фільтрує кожен крок, тож із чужого простору
 *  не видно навіть довжини ланцюга; протокол mismatch в update/forget передає
 *  сюди рівно той список, що й у CAS-кроці.
 *
 *  Аргумент ОБОВ'ЯЗКОВИЙ, хоч і допускає `undefined`: у модулі, весь сенс якого
 *  — розмежування просторів, коротшим викликом мусить бути безпечний. З
 *  необов'язковим параметром пропуск аргументу віддавав би голову з БУДЬ-ЯКОГО
 *  простору разом із текстом — без помилки типів і без червоного тесту. Тепер
 *  нескопований прочит — видиме рішення на місці виклику (`undefined`), а не
 *  забутий аргумент. */
export async function findCurrentHead(
  claimId: string,
  allowedSpaceIds: string[] | undefined,
  ex: Ex = db,
): Promise<ClaimHead | null> {
  // `inArray` з порожнім списком дає `false` — «жодного простору» читається як
  // «нічого не видно», а не як «усе».
  const scope = allowedSpaceIds ? inArray(vaultClaims.spaceId, allowedSpaceIds) : undefined;
  const select = (where: ReturnType<typeof eq>) =>
    ex
      .select({ ...HEAD, supersededAt: vaultClaims.supersededAt })
      .from(vaultClaims)
      .where(and(where, scope))
      .limit(1);

  const [start] = await select(eq(vaultClaims.id, claimId));
  if (!start) return null;

  let row = start;
  for (let hops = 0; ; hops++) {
    if (hops > MAX_CHAIN) throw new Error(`claim chain from ${claimId} does not terminate`);
    const [next] = await select(eq(vaultClaims.supersedes, row.id));
    if (!next) break;
    row = next;
  }
  const { supersededAt, ...head } = row;
  return supersededAt ? null : head;
}
