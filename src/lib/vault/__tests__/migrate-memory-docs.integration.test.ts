import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Перенос legacy memory_docs у сховище знань. Нічого, крім `createClaim`, не
 * мокається: увесь сенс цього модуля — в CAS на рядку документа й у тому, які
 * саме рядки Postgres відкотить разом із `migrated_at`, коли посеред документа
 * щось упаде. In-memory дубль перевіряв би власну уяву, а не базу.
 *
 * КОЖЕН виклик іде з `docIds`. Без нього `migrateMemoryDocs()` за побудовою бере
 * ВСІ непереноcені документи бази — а база тут спільна, і в ній лежить справжня
 * пам'ять розробника: suite мігрував би її й лишав по собі простір, тему, клейми
 * й проставлений `migrated_at`, яких не прибирає жоден prefix-scoped DELETE.
 * Асерти теж скоповані (`space_id = $1`, префіксовані id) — поруч живе воркер.
 */
import { pool } from "@/lib/db";
import { getOrCreateSpace } from "../spaces";
import { migrateMemoryDocs } from "../migrate-memory-docs";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Падіння «посеред документа» задається ТЕКСТОМ булета, а не порядковим
 *  номером виклику: порядок документів у вибірці не визначений, тож «третій
 *  виклик» — не наша змінна, а «третій булет ЦЬОГО документа» — наша. */
const hook = vi.hoisted(() => ({ failOn: null as string | null }));

vi.mock("../claims", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claims")>();
  return {
    ...actual,
    createClaim: (...args: Parameters<typeof actual.createClaim>) => {
      if (hook.failOn && args[0].statement === hook.failOn) {
        throw new Error(`mdmig: навмисне падіння на булеті «${hook.failOn}»`);
      }
      return actual.createClaim(...args);
    },
  };
});

/** Кожен id фікстури несе цей префікс. Простори id не контролюємо (nanoid
 *  зсередини), тож їх ловимо за owner_user_id. */
const P = "mdmig-";
const OWNER = `${P}owner`;
const PROJ = `${P}proj`;

/** Перенос лише названих документів — див. коментар до suite. */
const migrate = (...docIds: string[]) => migrateMemoryDocs({ docIds });

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const count = async (table: string, where: string, params: unknown[]) => {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].n);
};

/** users.email теж unique — таргетований ON CONFLICT (id) кинув би 23505 на
 *  залишковому рядку з тим самим email, і це виглядало б як skipped-тест. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'memory doc migration test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

const mkDoc = (id: string, content: string, projectId: string | null = null) =>
  q(`INSERT INTO memory_docs (id, user_id, project_id, content) VALUES ($1, $2, $3, $4)`, [
    id,
    OWNER,
    projectId,
    content,
  ]);

const spaceOf = async (type: "user" | "project", refId: string): Promise<string | null> => {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM spaces WHERE type = $1 AND ref_id = $2`, [
    type,
    refId,
  ]);
  return rows[0]?.id ?? null;
};

const statements = async (spaceId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ statement: string }>(
    `SELECT statement FROM vault_claims WHERE space_id = $1 AND superseded_at IS NULL`,
    [spaceId],
  );
  return rows.map((r) => r.statement);
};

/** Те, що справді побачить GET: клейми, ПРИВ'ЯЗАНІ до теми «Загальне». Клейм
 *  поза темою лишається в таблиці й зникає з екрана — різниця, яку прості
 *  лічильники клеймів не ловлять. */
const inTopic = async (spaceId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ statement: string }>(
    `SELECT c.statement FROM vault_claims c
       JOIN note_claims nc ON nc.claim_id = c.id
       JOIN vault_notes n ON n.id = nc.note_id
      WHERE c.space_id = $1 AND c.superseded_at IS NULL AND n.title = 'Загальне' AND n.kind = 'memory_topic'`,
    [spaceId],
  );
  return rows.map((r) => r.statement);
};

const migratedAt = async (docId: string): Promise<Date | null> => {
  const { rows } = await pool.query<{ migrated_at: Date | null }>(
    `SELECT migrated_at FROM memory_docs WHERE id = $1`,
    [docId],
  );
  return rows[0]?.migrated_at ?? null;
};

const snapshots = async (spaceId: string) => {
  const { rows } = await pool.query<{ actor: unknown; payload: { content?: string; docId?: string } }>(
    `SELECT actor, payload FROM audit_events
      WHERE space_id = $1 AND action = 'system.memory_doc_migrated' ORDER BY created_at`,
    [spaceId],
  );
  return rows;
};

const cleanup = async () => {
  await q(`DELETE FROM memory_docs WHERE id LIKE $1`, [`${P}%`]);
  // Простір тягне за собою клейми, теми, прив'язки й події.
  await q(`DELETE FROM spaces WHERE owner_user_id LIKE $1`, [`${P}%`]);
};

run("vault: перенос memory_docs", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await q(`INSERT INTO projects (id, user_id, name) VALUES ($1, $2, 'migration test') ON CONFLICT (id) DO NOTHING`, [
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
    hook.failOn = null;
    await cleanup();
  });

  it("булети документа стають підтвердженими legacy-клеймами в темі «Загальне» + снапшот", async () => {
    const content = "- любить чай\n\n* дедлайн у п'ятницю\n  - працює зі Львова\n";
    await mkDoc(`${P}d1`, content);

    expect(await migrate(`${P}d1`)).toEqual({ migrated: 1 });

    const spaceId = await spaceOf("user", OWNER);
    expect(spaceId).not.toBeNull();
    expect(new Set(await statements(spaceId!))).toEqual(
      new Set(["любить чай", "дедлайн у п'ятницю", "працює зі Львова"]),
    );
    // Походження й статус — те, за чим Task 8 відрізняє перенесене від нового,
    // і те, без чого маніфест підтверджених фактів документ не покаже.
    expect(
      await count(
        "vault_claims",
        "space_id = $1 AND review_status = 'confirmed' AND origin->>'kind' = 'legacy_memory_doc'",
        [spaceId],
      ),
    ).toBe(3);

    // Клейм поза темою невидимий для проєкції нот, тобто для UI не існує.
    expect(await inTopic(spaceId!)).toHaveLength(3);

    // Єдина копія оригінального markdown, що переживає перенос.
    const events = await snapshots(spaceId!);
    expect(events).toHaveLength(1);
    expect(events[0].payload.content).toBe(content);
    expect(events[0].payload.docId).toBe(`${P}d1`);
    expect(events[0].actor).toEqual({ kind: "system" });

    expect(await migratedAt(`${P}d1`)).not.toBeNull();
  });

  it("повторний виклик не додає нічого і не перештампує документ", async () => {
    await mkDoc(`${P}d2`, "- один\n- два");
    await migrate(`${P}d2`);

    const spaceId = (await spaceOf("user", OWNER))!;
    const stamp = await migratedAt(`${P}d2`);
    expect(stamp).not.toBeNull();

    expect(await migrate(`${P}d2`)).toEqual({ migrated: 0 });

    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(2);
    expect(await snapshots(spaceId)).toHaveLength(1);
    expect(await migratedAt(`${P}d2`)).toEqual(stamp);
  });

  it("гонка двох переносів не дублює жодного клейма (CAS на рядку документа)", async () => {
    await mkDoc(`${P}d3`, "- факт А\n- факт Б");

    const [a, b] = await Promise.all([migrate(`${P}d3`), migrate(`${P}d3`)]);

    // Рівно один із двох забрав документ — другий побачив нуль рядків на CAS.
    expect(a.migrated + b.migrated).toBe(1);
    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await statements(spaceId)).toHaveLength(2);
    expect(await inTopic(spaceId)).toHaveLength(2);
    expect(await snapshots(spaceId)).toHaveLength(1);
  });

  it("падіння посеред документа відкочує ВСЕ, включно з migrated_at; наступний прогін переносить чисто", async () => {
    await mkDoc(`${P}d4`, "- один\n- два\n- три\n- чотири");
    hook.failOn = "три";

    await expect(migrate(`${P}d4`)).rejects.toThrow(`1 memory doc(s) did not migrate: ${P}d4`);

    // Простір створювався в тій самій транзакції, тож його відсутність — і є
    // доказ повного відкату: ні клеймів, ні теми, ні події.
    expect(await spaceOf("user", OWNER)).toBeNull();
    expect(await migratedAt(`${P}d4`)).toBeNull();

    hook.failOn = null;
    await migrate(`${P}d4`);

    const spaceId = (await spaceOf("user", OWNER))!;
    expect(new Set(await statements(spaceId))).toEqual(new Set(["один", "два", "три", "чотири"]));
    expect(await migratedAt(`${P}d4`)).not.toBeNull();
  });

  it("документ, що падає, не ховає від переносу решту документів", async () => {
    await mkDoc(`${P}d8bad`, "- цілий\n- отруйний");
    await mkDoc(`${P}d8ok`, "- сусідній факт", PROJ);
    hook.failOn = "отруйний";

    // Кидок лишається — інакше retry на буті не спрацював би, — але тільки після
    // того, як решту документів уже перенесено. Порядок вибірки не визначений,
    // тож здоровий документ мусить доїхати, хоч який із двох ішов першим.
    await expect(migrate(`${P}d8bad`, `${P}d8ok`)).rejects.toThrow(`did not migrate: ${P}d8bad`);

    expect(await migratedAt(`${P}d8ok`)).not.toBeNull();
    expect(await statements((await spaceOf("project", PROJ))!)).toEqual(["сусідній факт"]);

    expect(await migratedAt(`${P}d8bad`)).toBeNull();
    expect(await spaceOf("user", OWNER)).toBeNull();
  });

  it("порожній документ штампується і не породжує клеймів", async () => {
    await mkDoc(`${P}d5`, "");

    await migrate(`${P}d5`);

    expect(await migratedAt(`${P}d5`)).not.toBeNull();
    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(0);
    const events = await snapshots(spaceId);
    expect(events).toHaveLength(1);
    expect(events[0].payload.content).toBe("");
  });

  it("булет, що вже існує клеймом поза темою, не дублюється — і потрапляє в «Загальне»", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    // Голова БЕЗ прив'язки до теми — саме те, що лишає по собі частковий прогін
    // або клейм, створений не реєстром кандидатів.
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, review_status)
       VALUES ($1, $2, 'Любить   чай', '{"kind":"legacy_memory_doc"}'::jsonb, 'confirmed')`,
      [`${P}claim`, spaceId],
    );
    await mkDoc(`${P}d6`, "- любить чай\n- нове");

    await migrate(`${P}d6`);

    // Нормалізація та сама, що в реєстрі кандидатів: регістр і кратні пробіли
    // не роблять із того самого факту два.
    expect(new Set(await statements(spaceId))).toEqual(new Set(["Любить   чай", "нове"]));
    // І пропуск булета не лишає факт поза екраном: GET читає лише «Загальне».
    expect(new Set(await inTopic(spaceId))).toEqual(new Set(["Любить   чай", "нове"]));
    expect(await count("note_claims", "claim_id = $1", [`${P}claim`])).toBe(1);
  });

  it("документ проєкту йде в проєктний простір, власником якого стає власник документа", async () => {
    await mkDoc(`${P}d7`, "- проєктний факт", PROJ);

    await migrate(`${P}d7`);

    const spaceId = await spaceOf("project", PROJ);
    expect(spaceId).not.toBeNull();
    expect(await count("spaces", "id = $1 AND owner_user_id = $2", [spaceId, OWNER])).toBe(1);
    expect(await statements(spaceId!)).toEqual(["проєктний факт"]);
  });
});
