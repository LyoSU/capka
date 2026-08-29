import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Перенос legacy memory_docs у сховище знань. Нічого, крім `createClaim`, не
 * мокається: увесь сенс цього модуля — в CAS на рядку документа й у тому, які
 * саме рядки Postgres відкотить разом із `migrated_at`, коли посеред документа
 * щось упаде. In-memory дубль перевіряв би власну уяву, а не базу.
 *
 * Асерти скоповані (`space_id = $1`, префіксовані id): інтеграційні файли
 * біжать проти ОДНІЄЇ спільної бази, у якій живуть і чужі документи — сама
 * `migrateMemoryDocs()` за побудовою бере їх усі, тож глобальні лічильники тут
 * нічого не доводять.
 */
import { pool } from "@/lib/db";
import { getOrCreateSpace } from "../spaces";
import { migrateMemoryDocs } from "../migrate-memory-docs";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Падіння «посеред документа» задається ТЕКСТОМ булета, а не порядковим
 *  номером виклику: у спільній базі є й чужі непереноcені документи, тож скільки
 *  разів `createClaim` покличуть до нашого — не наша змінна. */
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

const topicOf = async (spaceId: string): Promise<string | null> => {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM vault_notes WHERE space_id = $1 AND title = 'Загальне' AND kind = 'memory_topic'`,
    [spaceId],
  );
  return rows[0]?.id ?? null;
};

const statements = async (spaceId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ statement: string }>(
    `SELECT statement FROM vault_claims WHERE space_id = $1 AND superseded_at IS NULL`,
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

    const res = await migrateMemoryDocs();
    expect(res.migrated).toBeGreaterThanOrEqual(1);

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
    const noteId = await topicOf(spaceId!);
    expect(noteId).not.toBeNull();
    expect(await count("note_claims", "note_id = $1", [noteId])).toBe(3);

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
    await migrateMemoryDocs();

    const spaceId = (await spaceOf("user", OWNER))!;
    const stamp = await migratedAt(`${P}d2`);
    expect(stamp).not.toBeNull();

    await migrateMemoryDocs();

    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(2);
    expect(await snapshots(spaceId)).toHaveLength(1);
    expect(await migratedAt(`${P}d2`)).toEqual(stamp);
  });

  it("гонка двох переносів не дублює жодного клейма (CAS на рядку документа)", async () => {
    await mkDoc(`${P}d3`, "- факт А\n- факт Б");

    await Promise.all([migrateMemoryDocs(), migrateMemoryDocs()]);

    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await statements(spaceId)).toHaveLength(2);
    expect(await count("note_claims", "note_id = $1", [await topicOf(spaceId)])).toBe(2);
    expect(await snapshots(spaceId)).toHaveLength(1);
  });

  it("падіння посеред документа відкочує ВСЕ, включно з migrated_at; наступний прогін переносить чисто", async () => {
    await mkDoc(`${P}d4`, "- один\n- два\n- три\n- чотири");
    hook.failOn = "три";

    await expect(migrateMemoryDocs()).rejects.toThrow(/навмисне падіння/);

    // Простір створювався в тій самій транзакції, тож його відсутність — і є
    // доказ повного відкату: ні клеймів, ні теми, ні події.
    expect(await spaceOf("user", OWNER)).toBeNull();
    expect(await migratedAt(`${P}d4`)).toBeNull();

    hook.failOn = null;
    await migrateMemoryDocs();

    const spaceId = (await spaceOf("user", OWNER))!;
    expect(new Set(await statements(spaceId))).toEqual(new Set(["один", "два", "три", "чотири"]));
    expect(await migratedAt(`${P}d4`)).not.toBeNull();
  });

  it("порожній документ штампується і не породжує клеймів", async () => {
    await mkDoc(`${P}d5`, "");

    await migrateMemoryDocs();

    expect(await migratedAt(`${P}d5`)).not.toBeNull();
    const spaceId = (await spaceOf("user", OWNER))!;
    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(0);
    const events = await snapshots(spaceId);
    expect(events).toHaveLength(1);
    expect(events[0].payload.content).toBe("");
  });

  it("булет, що вже існує клеймом (частковий попередній прогін), не дублюється", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, review_status)
       VALUES ($1, $2, 'Любить   чай', '{"kind":"legacy_memory_doc"}'::jsonb, 'confirmed')`,
      [`${P}claim`, spaceId],
    );
    await mkDoc(`${P}d6`, "- любить чай\n- нове");

    await migrateMemoryDocs();

    // Нормалізація та сама, що в реєстрі кандидатів: регістр і кратні пробіли
    // не роблять із того самого факту два.
    expect(new Set(await statements(spaceId))).toEqual(new Set(["Любить   чай", "нове"]));
  });

  it("документ проєкту йде в проєктний простір, власником якого стає власник документа", async () => {
    await mkDoc(`${P}d7`, "- проєктний факт", PROJ);

    await migrateMemoryDocs();

    const spaceId = await spaceOf("project", PROJ);
    expect(spaceId).not.toBeNull();
    expect(await count("spaces", "id = $1 AND owner_user_id = $2", [spaceId, OWNER])).toBe(1);
    expect(await statements(spaceId!)).toEqual(["проєктний факт"]);
  });
});
