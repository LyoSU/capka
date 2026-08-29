import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditEvents, memoryDocs } from "@/lib/db/schema";
import { createClaim, listHeadClaims } from "./claims";
import { getOrCreateSpace, getOrCreateTopicNote } from "./spaces";

/** Та сама тема, у яку кладе факти реєстр кандидатів: клейм без теми не
 *  потрапляє в проєкцію нот, тобто для UI просто не існує. */
const DEFAULT_TOPIC = "Загальне";

/** Та сама нормалізація, що й у `candidates.ts`. Інші правила тут означали б,
 *  що той самий факт то зливається, то роздвоюється — залежно від того, яким
 *  шляхом він у пам'ять потрапив. */
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * Переносить legacy-документ пам'яті в клейми: рядок → булет → підтверджений
 * клейм із походженням `legacy_memory_doc`. Актор — `system`, а не реєстр
 * кандидатів: те, що вже лежало в пам'яті користувача, — не пропозиція на
 * розгляд, і просити підтвердити власні ж давні факти було б регресією.
 *
 * СЕЛЕКТОР — `migrated_at IS NULL`, і крапка. НЕ «або migrated_at < updated_at»:
 * коробка одна (compose, без rolling-реплік), а legacy-PUT стає 409 ТИМ САМИМ
 * деплоєм, що й ця міграція, — тож legacy-запис ПІСЛЯ успішного переносу
 * неможливий за побудовою. Ре-міграція «пізніх правок» була б машинерією без
 * сценарію, а ще й дублювала б відредаговані булети (додавання без supersede).
 *
 * ПРИПУЩЕННЯ ОДНОГО ПИСЬМЕННИКА: усе вище тримається на «одна коробка + PUT уже
 * 409». Helm-чарт з `ee/` із rolling-реплікою це припущення порушує — там дві
 * версії застосунку живуть одночасно, стара ще приймає PUT, і тоді потрібен
 * fence (фіча-флаг «legacy-запис закрито» ПЕРЕД переносом), а не цей селектор.
 * Записано явно, щоб план B/EE не наступив на це мовчки.
 */
export async function migrateMemoryDocs(): Promise<{ migrated: number }> {
  const pending = await db.select({ id: memoryDocs.id }).from(memoryDocs).where(isNull(memoryDocs.migratedAt));

  let migrated = 0;
  for (const doc of pending) if (await migrateOne(doc.id)) migrated++;
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
    const [doc] = await tx
      .update(memoryDocs)
      .set({ migratedAt: new Date() })
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
    // падіння (тоді клейми відкотились, але простір міг лишитись від сусіднього
    // документа) і збіг із фактом, який користувач уже сказав сам.
    const seen = new Set((await listHeadClaims(spaceId, {}, tx)).map((h) => norm(h.statement)));
    for (const line of doc.content.split("\n")) {
      const statement = line.trim().replace(/^[-*]\s*/, "").trim();
      if (!statement || seen.has(norm(statement))) continue;
      seen.add(norm(statement));
      await createClaim(
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
