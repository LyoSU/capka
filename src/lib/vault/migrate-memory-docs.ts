import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, memoryDocs } from "@/lib/db/schema";
import { attachToTopic, createClaim, listHeadClaims } from "./claims";
import { getOrCreateSpace, getOrCreateTopicNote } from "./spaces";

/** Та сама тема, у яку кладе факти реєстр кандидатів: клейм без теми не
 *  потрапляє в проєкцію нот, тобто для UI просто не існує. */
const DEFAULT_TOPIC = "Загальне";

/** Та сама нормалізація, що й у `candidates.ts`. Інші правила тут означали б,
 *  що той самий факт то зливається, то роздвоюється — залежно від того, яким
 *  шляхом він у пам'ять потрапив. */
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * Переносить legacy-документи пам'яті в клейми: рядок → булет → підтверджений
 * клейм із походженням `legacy_memory_doc`. Актор — `system`, а не реєстр
 * кандидатів: те, що вже лежало в пам'яті користувача, — не пропозиція на
 * розгляд, і просити підтвердити власні ж давні факти було б регресією.
 *
 * СЕЛЕКТОР — `migrated_at IS NULL`, і крапка. НЕ «або migrated_at < updated_at»:
 * ре-міграція «пізніх правок» дублювала б відредаговані булети (додавання без
 * supersede), а закриває те вікно не селектор, а cutover — див. нижче.
 *
 * ВІКНО ДО CUTOVER (Task 10) — реальне, і тримати його відкритим довго не можна.
 * `memory_docs` пише не лише legacy-PUT: у `src/lib/memory/store.ts` через
 * `optimisticUpdate` живуть ЧОТИРИ письменники — `maintainMemoryDoc` (ранер, після
 * КОЖНОГО ходу), `rememberFact`, `forgetFact` і `setMemoryDoc` (єдиний, куди
 * дістає PUT). Поки Task 10 не закрив усі чотири, кожен бут штампує `migrated_at`,
 * а три турн-письменники далі дописують `content` — і цих дописів уже не перенесе
 * ніхто: селектор дивиться на `IS NULL`, і fallback Task 10 читає той самий
 * стовпець, тож на cutover такі булети зникнуть з екрана. Звідси правило:
 * РЕЛІЗ МІЖ ЦИМ КОМІТОМ І CUTOVER-ОМ НЕ РІЗАТИ.
 *
 * ПРИПУЩЕННЯ ОДНОГО ПИСЬМЕННИКА (після cutover): «одна коробка, PUT уже 409».
 * Helm-чарт з `ee/` із rolling-реплікою його порушує — там дві версії застосунку
 * живуть одночасно, стара ще приймає запис, — і тоді потрібен fence (прапорець
 * «legacy-запис закрито» ПЕРЕД переносом), а не цей селектор. Записано явно, щоб
 * план B/EE не наступив на це мовчки.
 *
 * `docIds` звужує вибірку і потрібен ЛИШЕ тестам: без нього виклик за побудовою
 * бере всі непереноcені документи бази, тобто в спільній тестовій базі змітав би
 * і чужі, справжні. Бут аргументу не передає — його поведінка та сама.
 */
export async function migrateMemoryDocs(opts: { docIds?: string[] } = {}): Promise<{ migrated: number }> {
  const pending = await db
    .select({ id: memoryDocs.id })
    .from(memoryDocs)
    .where(and(isNull(memoryDocs.migratedAt), opts.docIds ? inArray(memoryDocs.id, opts.docIds) : undefined));

  let migrated = 0;
  const failed: string[] = [];
  let firstError: unknown;
  for (const doc of pending) {
    try {
      if (await migrateOne(doc.id)) migrated++;
    } catch (e) {
      // Ізоляція ПО ДОКУМЕНТУ. Без неї один документ, що падає детерміновано
      // (скажімо, NUL у legacy-контенті, записаному до того, як `stripNul`
      // затулив цей шлях), ховав би від переносу ВСІ документи після себе — на
      // кожному буті, назавжди, — а `SELECT` вище не впорядкований, тож навіть
      // «які саме» щоразу інші.
      failed.push(doc.id);
      firstError ??= e;
      console.error(`[vault] memory doc ${doc.id} did not migrate:`, e);
    }
  }
  // Кидаємо ОДИН раз і в кінці: решта документів на цей момент уже перенесена, а
  // retry в `migrate.ts` мусить лишитись озброєним — тихий успіх із
  // непереносеними документами був би гіршим за галасливий повтор.
  if (failed.length) {
    throw new Error(`${failed.length} memory doc(s) did not migrate: ${failed.join(", ")}`, { cause: firstError });
  }
  return { migrated };
}

/** Один документ — одна транзакція. Падіння посеред документа відкочує і
 *  клейми, і `migrated_at`, тож наступний бут добере його цілим; половини
 *  документа в пам'яті не буває. */
async function migrateOne(docId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // CAS-крок ПЕРШИЙ: він і бере блокування рядка, і перевіряє «ще не
    // перенесено» — між перевіркою й записом немає вікна. Нуль рядків = документ
    // узяв інший інстанс (або попередній прогін), і це не помилка, а пропуск.
    // Час — годинник БАЗИ (`now()`), як і `created_at` усіх сусідніх таблиць:
    // штамп із годинника контейнера не можна було б чесно порівняти з ними.
    const [doc] = await tx
      .update(memoryDocs)
      .set({ migratedAt: sql`now()` })
      .where(and(eq(memoryDocs.id, docId), isNull(memoryDocs.migratedAt)))
      .returning();
    if (!doc) return false;

    const spaceId = await getOrCreateSpace(
      doc.projectId
        ? // Власника проєктного простору беремо з САМОГО документа: чати проєкту
          // ділять один простір, а рядок проєкту тут читати нічим і нащо.
          { type: "project", refId: doc.projectId, ownerUserId: doc.userId }
        : { type: "user", refId: doc.userId },
      tx,
    );
    const noteId = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC, tx);

    // Дедуп проти вже наявних голів простору — рятує повтор після часткового
    // падіння і збіг із фактом, який користувач уже сказав сам.
    const seen = new Map((await listHeadClaims(spaceId, {}, tx)).map((h) => [norm(h.statement), h.id]));
    for (const line of doc.content.split("\n")) {
      const statement = line.trim().replace(/^[-*]\s*/, "").trim();
      if (!statement) continue;
      const known = seen.get(norm(statement));
      if (known !== undefined) {
        // Факт уже є — але, можливо, поза темами (його міг створити не реєстр
        // кандидатів). Просто пропустити булет означало б лишити рядок у базі й
        // прибрати його з екрана: GET читає «Загальне».
        await attachToTopic(known, noteId, tx);
        continue;
      }
      const claim = await createClaim(
        {
          spaceId,
          statement,
          origin: { kind: "legacy_memory_doc" },
          // НЕ "unverified": маніфест підтверджених фактів інакше не покаже
          // нічого з того, що користувач бачив у пам'яті вчора.
          reviewStatus: "confirmed",
          topicNoteId: noteId,
        },
        { kind: "system" },
        tx,
      );
      seen.set(norm(statement), claim.id);
    }

    // Єдина копія оригінального markdown, що переживає перенос: булети —
    // похідне від нього, а заголовки, порядок і форматування є лише тут.
    await tx.insert(auditEvents).values({
      id: nanoid(),
      spaceId,
      actor: { kind: "system" },
      action: "system.memory_doc_migrated",
      subjectType: "memory_doc",
      subjectId: docId,
      payload: { content: doc.content, docId },
    });
    return true;
  });
}
