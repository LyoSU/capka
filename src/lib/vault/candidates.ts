import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, memoryCandidates, vaultClaims } from "@/lib/db/schema";
import {
  attachEvidence,
  createClaim,
  headBySlot,
  listHeadClaims,
  updateClaim,
  type Actor,
  type EvidenceInput,
} from "./claims";
import { getOrCreateTopicNote, type Ex } from "./spaces";

export type Provenance = {
  kind: "user_direct" | "derived" | "tool" | "file" | "web" | "legacy_memory_doc";
  messageId?: string;
  detail?: string;
};

export type CandidateRow = typeof memoryCandidates.$inferSelect;

/** Тема за замовчуванням. Клейм БЕЗ теми не потрапляє в проєкцію нот, тобто
 *  для UI він просто не існує, — тож активація прив'язує тему ЗАВЖДИ. */
const DEFAULT_TOPIC = "Загальне";

/** Єдина нормалізація для порівняння текстів — і в слот-гілці, і в дедупі без
 *  слота. Різні правила в цих двох місцях означали б, що той самий факт то
 *  зливається, то роздвоюється залежно від наявності слоту. */
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * Чи це «слот уже зайняв конкурент» — і НІЩО інше.
 *
 * Drizzle ≥0.36 обгортає помилку драйвера, лишаючи pg-помилку в `cause`; старіші
 * версії кидають її напряму. Обидва варіанти читаються з ОДНОГО об'єкта: узяти
 * `code` з `e`, а `constraint` з `e.cause` означало б звірку двох різних помилок.
 *
 * Звірка йде по обох полях. По самому лише `23505` сюди потрапив би конфлікт
 * будь-якого іншого унікального індексу — і тихо поїхав би шляхом «конкурент
 * виграв», де нікого немає, а справжня несправність не залишила б сліду.
 */
function isSlotTaken(e: unknown): boolean {
  const pg = ((e as { code?: unknown })?.code ? e : (e as { cause?: unknown })?.cause) as
    | { code?: unknown; constraint?: unknown }
    | undefined;
  return pg?.code === "23505" && pg?.constraint === "uniq_vclaims_active_slot";
}

/** Два програші CAS поспіль. Кидається, щоб відкотити УСЮ транзакцію confirm —
 *  разом із `resolved_at`, який поставив крок 1. Кандидат лишається відкритим:
 *  «повернись пізніше» чесніше за тихо загублений факт. */
class TryAgain extends Error {}

/**
 * Реєстр кандидатів — ЄДИНИЙ вхід у пам'ять: агент не пише клейм, він пропонує,
 * а політика вирішує. Уся політика — одна зовнішня транзакція; кроки, що
 * вставляють клейми, — у вкладеному `tx.transaction()`, який drizzle емітить як
 * SAVEPOINT. Без нього unique violation абортила б усю транзакцію Postgres, і
 * «перечитати й вирішити» було б неможливим за побудовою, а не через недогляд.
 *
 * Актор тут завжди `agent`: пропозицію робить хід агента. Рішення людини
 * приходять окремими викликами (`confirmCandidate`/`rejectCandidate`) зі своїм
 * актором — саме цю різницю й видно в аудиті.
 */
export async function proposeCandidate(input: {
  idempotencyKey: string;
  spaceId: string;
  originMessageId?: string;
  statement: string;
  slotKey?: string;
  value?: unknown;
  provenance: Provenance;
  sensitive?: boolean;
  evidence?: EvidenceInput[];
  forceState?: "conflict";
  topicNoteId?: string;
}): Promise<
  | { state: "auto_active"; claimId: string; revision: number }
  | { state: "merged"; claimId: string }
  | { state: "pending" | "denied" | "conflict"; candidateId: string }
  | { state: "duplicate" }
> {
  const actor: Actor = { kind: "agent" };
  const evidence = input.evidence ?? [];

  // Гейт рахується ДО вставки: `policy_state` — NOT NULL, і провізорний стан із
  // подальшим UPDATE лише додав би стан, якого ніхто ніколи не бачить.
  const gate: "conflict" | "pending" | null =
    input.forceState === "conflict"
      ? "conflict"
      : input.sensitive
        ? "pending"
        : // Чого користувач не писав сам — не активується автоматично. Це і є
          // бар'єр проти ін'єкції через тул, файл чи сторінку.
          input.provenance.kind !== "user_direct"
          ? "pending"
          : null;

  return db.transaction(async (tx) => {
    const id = nanoid();
    const [row] = await tx
      .insert(memoryCandidates)
      .values({
        id,
        idempotencyKey: input.idempotencyKey,
        spaceId: input.spaceId,
        originMessageId: input.originMessageId ?? null,
        statement: input.statement,
        slotKey: input.slotKey ?? null,
        value: input.value ?? null,
        provenance: input.provenance,
        // Клейма для pending ще немає — докази чекають тут і застосовуються
        // тим, хто підтвердить.
        evidence,
        sensitive: input.sensitive ?? false,
        policyState: gate ?? "auto_active",
      })
      .onConflictDoNothing({ target: memoryCandidates.idempotencyKey })
      .returning({ id: memoryCandidates.id });

    // Цю саму пропозицію вже обробили. ПОВНИЙ no-op: жодного рядка, жодної
    // події — інакше повтор ходу дублював би аудит і докази.
    if (!row) return { state: "duplicate" } as const;

    const audit = (state: string, payload: Record<string, unknown>) =>
      tx.insert(auditEvents).values({
        id: nanoid(),
        spaceId: input.spaceId,
        actor,
        action: "candidate.propose",
        subjectType: "candidate",
        subjectId: id,
        // Без тексту пропозиції: аудит читають ширше, ніж сам простір знань.
        payload: { state, slotKey: input.slotKey ?? null, provenance: input.provenance.kind, ...payload },
      });

    if (gate) {
      await audit(gate, {});
      return { state: gate, candidateId: id } as const;
    }

    /** Факт уже відомий: доливаємо доказ і ЗАКРИВАЄМО кандидата. Відкритий
     *  merged-кандидат вічно просив би підтвердити те, що вже в пам'яті.
     *
     *  ПРИЙНЯТО: доказ, долитий до голови, яку паралельно supersede-нули, лишається
     *  на тій — тепер неактивній — версії. Це історично чесно (доказ стосується
     *  саме того формулювання), а агрегацію ланцюга покаже план D. */
    const merged = async (claimId: string) => {
      for (const ev of evidence) await attachEvidence(claimId, ev, tx);
      await tx
        .update(memoryCandidates)
        .set({ claimId, policyState: "auto_active", resolvedAt: new Date() })
        .where(eq(memoryCandidates.id, id));
      await audit("merged", { claimId });
      return { state: "merged", claimId } as const;
    };

    /** Слот зайнятий іншим твердженням — голову не чіпаємо, вибір за людиною. */
    const conflict = async (conflictsWith: string | null) => {
      await tx
        .update(memoryCandidates)
        .set({ policyState: "conflict", conflictsWith })
        .where(eq(memoryCandidates.id, id));
      await audit("conflict", { conflictsWith });
      return { state: "conflict", candidateId: id } as const;
    };

    const activate = async (sp: Ex) => {
      const noteId = input.topicNoteId ?? (await getOrCreateTopicNote(input.spaceId, DEFAULT_TOPIC, sp));
      const claim = await createClaim(
        {
          spaceId: input.spaceId,
          statement: input.statement,
          slotKey: input.slotKey,
          value: input.value,
          origin: { ...input.provenance },
          // НЕ "unverified": маніфест Task 8 перелічує лише confirmed, тож
          // щойно збережений користувачем факт інакше був би невидимий.
          reviewStatus: "confirmed",
          topicNoteId: noteId,
        },
        actor,
        sp,
      );
      for (const ev of evidence) await attachEvidence(claim.id, ev, sp);
      return claim;
    };

    const activated = async (claim: { id: string; revision: number }) => {
      await tx
        .update(memoryCandidates)
        .set({ claimId: claim.id, policyState: "auto_active", resolvedAt: new Date() })
        .where(eq(memoryCandidates.id, id));
      await audit("auto_active", { claimId: claim.id });
      return { state: "auto_active", claimId: claim.id, revision: claim.revision } as const;
    };

    if (input.slotKey) {
      const head = await headBySlot(input.spaceId, input.slotKey, tx);
      if (head) return norm(head.statement) === norm(input.statement) ? merged(head.id) : conflict(head.id);

      let claim: { id: string; revision: number };
      try {
        claim = await tx.transaction(activate);
      } catch (e) {
        if (!isSlotTaken(e)) throw e;
        // Конкурент устиг закомітити голову в цей слот, поки ми вставляли свою.
        // 23505 приходить лише ПІСЛЯ його коміту (до того INSERT просто чекає на
        // блокуванні індексу), тож read-committed перечитування його вже бачить.
        const winner = await headBySlot(input.spaceId, input.slotKey, tx);
        // Голови немає — між його комітом і нашим прочитом хтось третій її
        // забув/перекрив. Не вигадуємо переможця й не віддаємо назовні pg-помилку:
        // слот спірний, кандидат лишається відкритим для людини.
        if (!winner) return conflict(null);
        return norm(winner.statement) === norm(input.statement) ? merged(winner.id) : conflict(winner.id);
      }
      return activated(claim);
    }

    // Без слота унікального індексу немає (`uniq_vclaims_active_slot` партіальний
    // на `slot_key IS NOT NULL`), тож і 23505 неможливий — SAVEPOINT тут був би
    // порожньою обгорткою. Гонка двох РІЗНИХ тверджень дасть два клейми; це
    // прийнято, курує людина.
    const heads = await listHeadClaims(input.spaceId, {}, tx);
    const dup = heads.find((h) => norm(h.statement) === norm(input.statement));
    if (dup) return merged(dup.id);
    return activated(await activate(tx));
  });
}

/**
 * Рішення людини «так». Одна транзакція; політика перечитується ЗАНОВО — між
 * пропозицією і підтвердженням світ міг змінитись, і підтверджують саме зміст
 * кандидата, а не той стан слоту, який був колись.
 */
export async function confirmCandidate(args: {
  candidateId: string;
  allowedSpaceIds: string[];
  actor: Actor;
}): Promise<{ ok: true; claimId: string } | { ok: false; reason: "already_resolved" | "not_found" | "try_again" }> {
  const { candidateId, allowedSpaceIds, actor } = args;
  try {
    return await db.transaction(async (tx) => {
      // CAS-крок ПЕРШИЙ: він і арбітрує confirm/confirm та confirm/reject, і бере
      // блокування рядка — між перевіркою «ще відкритий» і записом немає вікна.
      const [cand] = await tx
        .update(memoryCandidates)
        .set({ resolvedAt: new Date() })
        .where(
          and(
            eq(memoryCandidates.id, candidateId),
            isNull(memoryCandidates.resolvedAt),
            inArray(memoryCandidates.spaceId, allowedSpaceIds),
          ),
        )
        .returning();

      if (!cand) {
        // Розрізняємо «вже вирішено» і «немає» тим самим space-фільтром: чужий
        // кандидат читається як не-існуючий, а не як «є, але не твій».
        const [seen] = await tx
          .select({ id: memoryCandidates.id })
          .from(memoryCandidates)
          .where(and(eq(memoryCandidates.id, candidateId), inArray(memoryCandidates.spaceId, allowedSpaceIds)))
          .limit(1);
        return { ok: false, reason: seen ? "already_resolved" : "not_found" } as const;
      }

      const evidence = (cand.evidence ?? []) as EvidenceInput[];
      const finish = async (claimId: string) => {
        // `policy_state` лишається як був: перехід pending→підтверджено фіксує
        // подія, а не переписаний стан пропозиції.
        await tx.update(memoryCandidates).set({ claimId }).where(eq(memoryCandidates.id, cand.id));
        await tx.insert(auditEvents).values({
          id: nanoid(),
          spaceId: cand.spaceId,
          actor,
          action: "candidate.confirm",
          subjectType: "candidate",
          subjectId: cand.id,
          payload: { claimId, policyState: cand.policyState, slotKey: cand.slotKey },
        });
        return { ok: true, claimId } as const;
      };

      // Дві спроби: програш CAS — не помилка, а «голову щойно змінили», і
      // правильна відповідь на неї — перечитати. Другий програш поспіль означає
      // живу конкуренцію за цей слот, і тоді чесніше сказати «пізніше».
      for (let attempt = 0; attempt < 2; attempt++) {
        const claimId = await tx
          .transaction(async (sp): Promise<string | null> => {
            const head = cand.slotKey ? await headBySlot(cand.spaceId, cand.slotKey, sp) : null;

            if (head && norm(head.statement) === norm(cand.statement)) {
              for (const ev of evidence) await attachEvidence(head.id, ev, sp);
              return head.id;
            }

            if (head) {
              const upd = await updateClaim(
                {
                  claimId: head.id,
                  expectedRevision: head.revision,
                  patch: { statement: cand.statement, value: cand.value },
                  allowedSpaceIds,
                  actor,
                },
                sp,
              );
              if (!upd.ok) return null; // програли CAS — перечитати
              // `updateClaim` копіює review_status і sensitive з попередника —
              // навмисно, бо supersede сам по собі нічого не стверджує. Але це
              // ПІДТВЕРДЖЕННЯ, тож наступник мусить бути confirmed, інакше факт
              // не потрапить у маніфест. Чутливість тільки піднімається: зняти
              // її тут означало б розкрити те, що вже позначили закритим.
              await sp
                .update(vaultClaims)
                .set({ reviewStatus: "confirmed", sensitive: head.sensitive || cand.sensitive })
                .where(eq(vaultClaims.id, upd.id));
              for (const ev of evidence) await attachEvidence(upd.id, ev, sp);
              return upd.id;
            }

            const noteId = await getOrCreateTopicNote(cand.spaceId, DEFAULT_TOPIC, sp);
            const claim = await createClaim(
              {
                spaceId: cand.spaceId,
                statement: cand.statement,
                slotKey: cand.slotKey ?? undefined,
                value: cand.value,
                origin: cand.provenance as Record<string, unknown>,
                reviewStatus: "confirmed",
                sensitive: cand.sensitive,
                topicNoteId: noteId,
              },
              actor,
              sp,
            );
            for (const ev of evidence) await attachEvidence(claim.id, ev, sp);
            return claim.id;
          })
          // Слот забрали між нашим прочитом і вставкою — та сама відповідь, що й
          // на програш CAS: перечитати. Чужий constraint летить далі.
          .catch((e: unknown) => {
            if (isSlotTaken(e)) return null;
            throw e;
          });

        if (claimId) return finish(claimId);
      }

      throw new TryAgain();
    });
  } catch (e) {
    if (e instanceof TryAgain) return { ok: false, reason: "try_again" };
    throw e;
  }
}

/** Рішення людини «ні»: той самий CAS-резолв, що арбітрує гонку з confirm.
 *  `policy_state` не переписується — відмову фіксує подія, і початковий стан
 *  пропозиції лишається читабельним. */
export async function rejectCandidate(args: {
  candidateId: string;
  allowedSpaceIds: string[];
  actor: Actor;
}): Promise<{ ok: boolean }> {
  const { candidateId, allowedSpaceIds, actor } = args;
  return db.transaction(async (tx) => {
    const [cand] = await tx
      .update(memoryCandidates)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(memoryCandidates.id, candidateId),
          isNull(memoryCandidates.resolvedAt),
          inArray(memoryCandidates.spaceId, allowedSpaceIds),
        ),
      )
      .returning({
        id: memoryCandidates.id,
        spaceId: memoryCandidates.spaceId,
        policyState: memoryCandidates.policyState,
      });
    if (!cand) return { ok: false };

    await tx.insert(auditEvents).values({
      id: nanoid(),
      spaceId: cand.spaceId,
      actor,
      action: "candidate.reject",
      subjectType: "candidate",
      subjectId: cand.id,
      payload: { policyState: cand.policyState },
    });
    return { ok: true };
  });
}

/** Черга перегляду простору: найстаріші першими — людина розбирає її з початку,
 *  а не з кінця. Читається по `idx_mcand_unresolved`. */
export async function listOpenCandidates(spaceId: string): Promise<CandidateRow[]> {
  return db
    .select()
    .from(memoryCandidates)
    .where(and(eq(memoryCandidates.spaceId, spaceId), isNull(memoryCandidates.resolvedAt)))
    .orderBy(asc(memoryCandidates.createdAt), asc(memoryCandidates.id));
}

/**
 * Чи справді користувач це писав: ≥60% слів твердження довжиною >3 присутні в
 * тексті його ходу. Грубий фільтр проти ін'єкції — щоб результат тула чи
 * сторінка не могли стверджувати, ніби це сказав користувач.
 *
 * Слабкості (заперечення, лапки, переказ чужих слів) відомі й прийняті: ціна
 * помилки — одне зайве підтвердження, а не втрачений факт, тож розумнішим цей
 * фільтр робити не треба. Коротких слів це не стосується — вони є в будь-якому
 * тексті й нічого не підтверджують; якщо довгих слів немає взагалі, підтвердити
 * авторство нічим, і відповідь `false` (тобто pending) — єдина чесна.
 */
export function verifyDirectProvenance(statement: string, userTurnText: string): boolean {
  const words = statement
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3);
  if (words.length === 0) return false;
  const haystack = userTurnText.toLowerCase();
  return words.filter((w) => haystack.includes(w)).length / words.length >= 0.6;
}
