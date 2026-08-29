import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Маніфест пам'яті — рядок, який іде в системний промпт на КОЖЕН хід. Нічого
 * не мокається: сенс тесту саме в тому, які рядки реально повертає Postgres
 * (лічильники через JOIN, фільтр confirmed+non-sensitive, легасі-fallback за
 * migrated_at) — in-memory дубль перевіряв би власну уяву про запит, а не сам
 * запит. Асерти скоповані (id з префіксом, `space_id = $1`) — суперечка з
 * реальним воркером на спільній базі тут неможлива за побудовою (маніфест
 * лише читає).
 */
import { pool } from "@/lib/db";
import { createClaim } from "../claims";
import { getOrCreateTopicNote } from "../spaces";
import { proposeCandidate } from "../candidates";
import { buildMemoryManifest } from "../manifest";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Кожен id фікстури несе цей префікс — прибирання одним LIKE на таблицю. */
const P = "mnfsttest-";
const OWNER = `${P}owner`;
const PROJ = `${P}proj`;
const SPACE_A = `${P}space-a`; // user
const SPACE_B = `${P}space-b`; // project

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** users.email теж unique — таргетований ON CONFLICT (id) кинув би 23505 на
 *  залишковому рядку з тим самим email, і це виглядало б як skipped-тест. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'manifest test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

const cleanup = async () => {
  await q(`DELETE FROM memory_docs WHERE user_id = $1`, [OWNER]);
  // Простір тягне за собою клейми, теми, прив'язки, кандидатів і події.
  await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
};

/** Швидкий шлях до фактового клейма в конкретній темі — обходить весь реєстр
 *  кандидатів там, де тест перевіряє не політику активації (її вже покриває
 *  `candidates.integration.test.ts`), а рендер маніфеста над готовим станом. */
const addFact = (
  spaceId: string,
  statement: string,
  opts: { sensitive?: boolean; reviewStatus?: "confirmed" | "unverified"; topic?: string } = {},
) =>
  getOrCreateTopicNote(spaceId, opts.topic ?? "Загальне").then((noteId) =>
    createClaim(
      {
        spaceId,
        statement,
        origin: { kind: "legacy_memory_doc" },
        reviewStatus: opts.reviewStatus ?? "confirmed",
        sensitive: opts.sensitive ?? false,
        topicNoteId: noteId,
      },
      { kind: "system" },
    ),
  );

// `beforeEach` очищає memory_docs цього OWNER-а перед КОЖНИМ тестом, тож
// (user_id, project_id) тут завжди свіжий — ON CONFLICT не потрібен, а партіальний
// unique-індекс на project_id IS NULL зробив би цільований ON CONFLICT (user_id,
// project_id) неоднозначним (два різні unique-індекси покривають цей випадок).
let seq = 0;
const mkDoc = (userId: string, projectId: string | null, content: string) =>
  q(`INSERT INTO memory_docs (id, user_id, project_id, content) VALUES ($1, $2, $3, $4)`, [
    `${P}doc-${++seq}`,
    userId,
    projectId,
    content,
  ]);

run("vault: маніфест пам'яті", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, 'manifest test') ON CONFLICT (id) DO NOTHING`, [
      PROJ,
      OWNER,
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM projects WHERE id = $1`, [PROJ]);
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(async () => {
    await cleanup();
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'user', $2, $2)`, [SPACE_A, OWNER]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'project', $2, $3)`, [
      SPACE_B,
      PROJ,
      OWNER,
    ]);
  });

  it("лічильники тем рахують лише confirmed non-sensitive голови через note_claims", async () => {
    await addFact(SPACE_A, "Любить каву");
    await addFact(SPACE_A, "Живе в Одесі");
    await addFact(SPACE_A, "Працює менеджером", { topic: "Робота" });
    // Не мають зайти в лічильник теми «Загальне»:
    await addFact(SPACE_A, "Чутливий факт у Загальному", { sensitive: true });
    await addFact(SPACE_A, "Ще не підтверджено", { reviewStatus: "unverified" });

    const manifest = await buildMemoryManifest({ userId: OWNER, userSpaceId: SPACE_A });

    expect(manifest).toContain("- Загальне — 2 фактів");
    expect(manifest).toContain("- Робота — 1 фактів");
  });

  it("unverified і sensitive відсутні в тексті маніфеста дослівно", async () => {
    await addFact(SPACE_A, "Публічний підтверджений факт");
    await addFact(SPACE_A, "Секретна зарплата 100500", { sensitive: true });
    await addFact(SPACE_A, "Непідтверджена гіпотеза", { reviewStatus: "unverified" });

    const manifest = await buildMemoryManifest({ userId: OWNER, userSpaceId: SPACE_A });

    expect(manifest).toContain("Публічний підтверджений факт");
    expect(manifest).not.toContain("Секретна зарплата 100500");
    expect(manifest).not.toContain("Непідтверджена гіпотеза");
  });

  it("свіжий auto_active клейм (confirmed через user_direct) — присутній в «Останніх фактах»", async () => {
    // Провенанс заданий напряму як user_direct — саме той шлях, яким candidates.ts
    // (Task 5) активує клейм одразу як confirmed; verifyDirectProvenance
    // перевіряється окремо в candidates.integration.test.ts.
    const res = await proposeCandidate({
      idempotencyKey: `${P}idem-auto`,
      spaceId: SPACE_A,
      statement: "Я з відділу закупівель",
      provenance: { kind: "user_direct", messageId: `${P}msg` },
    });
    expect(res.state).toBe("auto_active");

    const manifest = await buildMemoryManifest({ userId: OWNER, userSpaceId: SPACE_A });
    expect(manifest).toContain("Я з відділу закупівель");
  });

  it("два послідовних виклики без зміни стану — байт-у-байт ідентичні", async () => {
    await addFact(SPACE_A, "Факт А");
    await addFact(SPACE_A, "Факт Б", { topic: "Робота" });
    await addFact(SPACE_A, "Секретний факт", { sensitive: true });
    await addFact(SPACE_B, "Проєктний факт");
    await mkDoc(OWNER, null, "- легасі рядок, ще не мігрований");

    const first = await buildMemoryManifest({
      userId: OWNER,
      userSpaceId: SPACE_A,
      projectId: PROJ,
      projectSpaceId: SPACE_B,
    });
    const second = await buildMemoryManifest({
      userId: OWNER,
      userSpaceId: SPACE_A,
      projectId: PROJ,
      projectSpaceId: SPACE_B,
    });

    expect(second).toBe(first);
  });

  it("порожній vault (без клеймів, без тем, без legacy-doc) → мінімум: лише заголовки і хвіст", async () => {
    const manifest = await buildMemoryManifest({
      userId: OWNER,
      userSpaceId: SPACE_A,
      projectId: PROJ,
      projectSpaceId: SPACE_B,
    });

    expect(manifest).toContain("## Пам'ять про користувача");
    expect(manifest).toContain("## Пам'ять проєкту");
    expect(manifest).not.toContain("Теми:");
    expect(manifest).not.toContain("Останні факти:");
    expect(manifest).not.toContain("Пам'ять (мігрується)");
    expect(manifest).toContain(
      "Use memory_search before assuming facts about the user or project; propose new facts with memory_propose.",
    );
  });

  it("маніфест НЕ згадує search_knowledge — цей тул ще не існує (план C)", async () => {
    const manifest = await buildMemoryManifest({ userId: OWNER, userSpaceId: SPACE_A });
    expect(manifest).not.toContain("search_knowledge");
  });

  it("немігрований memory_docs користувача → секція «Пам'ять (мігрується)»; після migrated_at — зникає", async () => {
    await mkDoc(OWNER, null, "- легасі факт користувача\n- другий рядок");

    const before = await buildMemoryManifest({ userId: OWNER, userSpaceId: SPACE_A });
    expect(before).toContain("## Пам'ять (мігрується)");
    expect(before).toContain("легасі факт користувача");

    await q(`UPDATE memory_docs SET migrated_at = now() WHERE user_id = $1 AND project_id IS NULL`, [OWNER]);

    const after = await buildMemoryManifest({ userId: OWNER, userSpaceId: SPACE_A });
    expect(after).not.toContain("Пам'ять (мігрується)");
    expect(after).not.toContain("легасі факт користувача");
  });

  it("немігрований memory_docs проєкту рендериться в секції легасі під міткою «Проєкт»", async () => {
    await mkDoc(OWNER, PROJ, "- проєктний легасі факт");

    const manifest = await buildMemoryManifest({
      userId: OWNER,
      userSpaceId: SPACE_A,
      projectId: PROJ,
      projectSpaceId: SPACE_B,
    });

    expect(manifest).toContain("Проєкт:");
    expect(manifest).toContain("проєктний легасі факт");
  });

  it("legacy-контент понад 4КБ обрізається капом, а не летить у промпт цілим", async () => {
    const big = "x".repeat(5000);
    await mkDoc(OWNER, null, big);

    const manifest = await buildMemoryManifest({ userId: OWNER, userSpaceId: SPACE_A });

    expect(manifest).toContain("x".repeat(4096));
    expect(manifest).not.toContain("x".repeat(4097));
  });

  it("порожній (лише пробіли) legacy-doc не породжує порожньої секції", async () => {
    await mkDoc(OWNER, null, "   \n  ");

    const manifest = await buildMemoryManifest({ userId: OWNER, userSpaceId: SPACE_A });
    expect(manifest).not.toContain("Пам'ять (мігрується)");
  });

  it("факт у проєктному просторі видно лише в проєктній секції, не в user-секції", async () => {
    await addFact(SPACE_B, "Дедлайн у п'ятницю", { topic: "Робота" });

    const manifest = await buildMemoryManifest({
      userId: OWNER,
      userSpaceId: SPACE_A,
      projectId: PROJ,
      projectSpaceId: SPACE_B,
    });

    const userSection = manifest.slice(0, manifest.indexOf("## Пам'ять проєкту"));
    const projectSection = manifest.slice(manifest.indexOf("## Пам'ять проєкту"));

    expect(userSection).not.toContain("Дедлайн у п'ятницю");
    expect(projectSection).toContain("Дедлайн у п'ятницю");
  });
});
