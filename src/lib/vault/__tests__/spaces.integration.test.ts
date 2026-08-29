import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Резолвери просторів і життєвий цикл власника. Нічого не мокається: обидва
 * get-or-create існують ЛИШЕ заради гонки на unique-індексі, а весь сенс
 * retire/purge — у тому, які саме рядки Postgres знесе каскадом і де RESTRICT
 * цитати відкотить транзакцію. Будь-який in-memory дубль тут перевіряв би
 * власну уяву, а не базу.
 */
import { eq } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getOrCreateSpace, getOrCreateTopicNote, retireProjectSpace, purgeUserSpaces } from "../spaces";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Кожен id фікстури несе цей префікс — прибирання одним LIKE на таблицю.
 *  Простори id не контролюємо (nanoid зсередини), тож їх ловимо за owner_user_id. */
const P = "spctest-";
const OWNER = `${P}owner`;
const CHAT = `${P}chat`;
const MSG = `${P}msg`;
const PROJ = `${P}proj`;

const FK_VIOLATION = "23503";

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
     VALUES ($1, 'spaces test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

/** Повний ланцюг source→version→fragment під простором. */
const mkChain = async (spaceId: string, tag: string) => {
  const source = `${P}${tag}-src`;
  const version = `${P}${tag}-ver`;
  const fragment = `${P}${tag}-frag`;
  await q(
    `INSERT INTO knowledge_sources (id, space_id, title, origin, created_by)
     VALUES ($1, $2, 'fixture', '{"type":"upload"}'::jsonb, $3)`,
    [source, spaceId, OWNER],
  );
  await q(`INSERT INTO knowledge_source_versions (id, source_id, sha256) VALUES ($1, $2, $3)`, [
    version,
    source,
    "a".repeat(64),
  ]);
  await q(
    `INSERT INTO knowledge_fragments (id, version_id, ordinal, text, locator)
     VALUES ($1, $2, 0, 'fixture fragment', '{"scheme":"char"}'::jsonb)`,
    [fragment, version],
  );
  return { source, version, fragment };
};

/** Цитата робиться руками: мінтинг живе в плані C, а пін нам потрібен уже тут. */
const mkCitation = async (tag: string, versionId: string, fragmentId: string) => {
  const id = `${P}${tag}-cit`;
  await q(
    `INSERT INTO message_citations
       (id, message_id, ordinal, source_version_id, fragment_id, quote_snapshot, locator_snapshot, title_snapshot)
     VALUES ($1, $2, 1, $3, $4, 'quoted text', '{"scheme":"char"}'::jsonb, 'fixture')`,
    [id, MSG, versionId, fragmentId],
  );
  return id;
};

const mkClaim = (id: string, spaceId: string) =>
  q(`INSERT INTO vault_claims (id, space_id, statement, origin) VALUES ($1, $2, 'факт', '{}'::jsonb)`, [id, spaceId]);

const retireEvents = (spaceId: string) => count("audit_events", "space_id = $1 AND action = 'space.retire'", [spaceId]);

const cleanup = async () => {
  // Цитати пінять каскад, тому йдуть першими — той самий порядок, який мусить
  // тримати продукт.
  await q(`DELETE FROM message_citations WHERE id LIKE $1`, [`${P}%`]);
  await q(`DELETE FROM spaces WHERE owner_user_id LIKE $1`, [`${P}%`]);
  // Підопитні користувачі створюються всередині тестів; OWNER живе до afterAll.
  await q(`DELETE FROM "user" WHERE id LIKE $1 AND id <> $2`, [`${P}%`, OWNER]);
};

run("vault spaces", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await q(`INSERT INTO chats (id, user_id, title) VALUES ($1, $2, 'spaces test') ON CONFLICT (id) DO NOTHING`, [
      CHAT,
      OWNER,
    ]);
    await q(
      `INSERT INTO messages (id, chat_id, role, content) VALUES ($1, $2, 'assistant', 'hi')
         ON CONFLICT (id) DO NOTHING`,
      [MSG, CHAT],
    );
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM chats WHERE id = $1`, [CHAT]); // messages → citations каскадом
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(cleanup);

  it("паралельний getOrCreateSpace дає РІВНО один простір", async () => {
    const ids = await Promise.all([
      getOrCreateSpace({ type: "user", refId: OWNER }),
      getOrCreateSpace({ type: "user", refId: OWNER }),
      getOrCreateSpace({ type: "user", refId: OWNER }),
    ]);
    expect(new Set(ids).size).toBe(1);
    expect(await count("spaces", "type = 'user' AND ref_id = $1", [OWNER])).toBe(1);
    // Для user-простору власник = refId (проєктний бере ownerUserId від колера).
    expect(await count("spaces", "id = $1 AND owner_user_id = $2", [ids[0], OWNER])).toBe(1);
  });

  it("проєктний простір записує переданого власника, а не свій refId", async () => {
    const id = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    expect(await count("spaces", "id = $1 AND type = 'project' AND ref_id = $2 AND owner_user_id = $3", [id, PROJ, OWNER])).toBe(1);
  });

  it("паралельний getOrCreateTopicNote дає РІВНО одну тему", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const notes = await Promise.all([
      getOrCreateTopicNote(spaceId, "Робота"),
      getOrCreateTopicNote(spaceId, "Робота"),
      getOrCreateTopicNote(spaceId, "Робота"),
    ]);
    expect(new Set(notes).size).toBe(1);
    expect(await count("vault_notes", "space_id = $1 AND title = 'Робота'", [spaceId])).toBe(1);
    // Унікальність назв — партіальна, лише для kind='memory_topic', тож тема
    // мусить створюватись саме таким видом, інакше індекс її не ловить.
    expect(await count("vault_notes", "id = $1 AND kind = 'memory_topic'", [notes[0]])).toBe(1);
  });

  it("retire: пам'ять проєкту вмирає, джерела/версії/фрагменти/цитата живуть", async () => {
    const spaceId = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, "Проєктна тема");
    const claim = `${P}claim`;
    await mkClaim(claim, spaceId);
    await q(`INSERT INTO note_claims (note_id, claim_id) VALUES ($1, $2)`, [noteId, claim]);
    await q(`INSERT INTO claim_evidence (id, claim_id) VALUES ($1, $2)`, [`${P}ev`, claim]);
    await q(
      `INSERT INTO memory_candidates (id, idempotency_key, space_id, statement, provenance, policy_state)
       VALUES ($1, $1, $2, 'кандидат', '{}'::jsonb, 'pending')`,
      [`${P}cand`, spaceId],
    );
    const { source, version, fragment } = await mkChain(spaceId, "retire");
    const cit = await mkCitation("retire", version, fragment);

    await retireProjectSpace(PROJ);

    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(0);
    expect(await count("note_claims", "claim_id = $1", [claim])).toBe(0);
    expect(await count("claim_evidence", "claim_id = $1", [claim])).toBe(0);
    expect(await count("vault_notes", "space_id = $1", [spaceId])).toBe(0);
    expect(await count("memory_candidates", "space_id = $1", [spaceId])).toBe(0);

    // Джерело — SOFT delete: рядок на місці, позначений видаленим.
    expect(await count("knowledge_sources", "id = $1 AND deleted_at IS NOT NULL", [source])).toBe(1);
    // Чат пережив проєкт, тож його цитата й далі пінить версію та фрагмент.
    expect(await count("knowledge_source_versions", "id = $1", [version])).toBe(1);
    expect(await count("knowledge_fragments", "id = $1", [fragment])).toBe(1);
    expect(await count("message_citations", "id = $1", [cit])).toBe(1);
    // Сам простір лишається — його знайде purge за owner_user_id.
    expect(await count("spaces", "id = $1", [spaceId])).toBe(1);
    expect(await retireEvents(spaceId)).toBe(1);
  });

  it("retire пише РІВНО одну подію — і на повтор, і на порожньому просторі", async () => {
    // Непорожній простір: так teardown передрайвлюється з worker-тіка після
    // часткової невдачі, і другої події бути не мусить.
    const spaceId = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    await mkClaim(`${P}claim2`, spaceId);
    await retireProjectSpace(PROJ);
    expect(await retireEvents(spaceId)).toBe(1);
    await expect(retireProjectSpace(PROJ)).resolves.toBeUndefined();
    expect(await retireEvents(spaceId)).toBe(1);

    // Порожній простір (користувач почистив усе руками): зносити нічого, але слід
    // усе одно мусить бути — інакше «події немає» читається як «teardown не
    // доїхав», а це та сама відповідь, яку оператор шукає в аудиті.
    const emptyProj = `${P}empty-proj`;
    const emptySpace = await getOrCreateSpace({ type: "project", refId: emptyProj, ownerUserId: OWNER });
    await retireProjectSpace(emptyProj);
    expect(await retireEvents(emptySpace)).toBe(1);
    await retireProjectSpace(emptyProj);
    expect(await retireEvents(emptySpace)).toBe(1);

    // І простору, якого взагалі немає, теж терпить.
    await expect(retireProjectSpace(`${P}never-existed`)).resolves.toBeUndefined();
  });

  it("retire серіалізується на рядку простору, тож подія не двоїться", async () => {
    // «Події ще немає» — це read-modify-write, і на ПОРОЖНЬОМУ просторі жоден
    // інший рядок транзакції не серіалізує, тож умову тримає лише блокування
    // рядка простору. Паралельний виклик тут нічого не довів би: без блокування
    // він однаково зелений, бо перша транзакція встигає закомітитись. Тому лок
    // спостерігається прямо — чужа транзакція тримає рядок, і retire не рухається.
    const lockProj = `${P}lock-proj`;
    const spaceId = await getOrCreateSpace({ type: "project", refId: lockProj, ownerUserId: OWNER });

    const holder = await pool.connect();
    let pending: Promise<void>;
    try {
      await holder.query("BEGIN");
      // Саме FOR KEY SHARE, а не FOR UPDATE: він конфліктує з локом retire, але
      // НЕ з тим FOR KEY SHARE, який INSERT в audit_events бере на батьківський
      // рядок через FK. З FOR UPDATE тут блокувалась би й сама вставка, і тест
      // був би зелений навіть без лока — тобто не перевіряв би нічого. Ця ж
      // асиметрія і є причиною лока: два одночасні retire без нього беруть лише
      // по FOR KEY SHARE, які між собою не конфліктують, і подія двоїться.
      await holder.query("SELECT id FROM spaces WHERE id = $1 FOR KEY SHARE", [spaceId]);
      pending = retireProjectSpace(lockProj);
      const outcome = await Promise.race([
        pending.then(() => "done" as const),
        new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 500)),
      ]);
      expect(outcome).toBe("blocked");
      expect(await retireEvents(spaceId)).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    // Лок віддано — той самий виклик доходить, рівно з однією подією.
    await pending;
    expect(await retireEvents(spaceId)).toBe(1);
  });

  it("усі три функції читають і пишуть ЧЕРЕЗ переданий ex", async () => {
    // Стан ДО транзакції: простір проєкту з одним клеймом, обидва закоммічені.
    const spaceId = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    const claim = `${P}claim-ex`;
    await mkClaim(claim, spaceId);
    const userRef = `${P}ex-user`;
    const topic = "Тема в транзакції";

    const seen = { space: [] as string[], note: [] as string[] };
    const boom = new Error("rollback");
    const err = await db
      .transaction(async (tx) => {
        // Другий виклик мусить ПОБАЧИТИ незакоммічений рядок першого: SELECT повз
        // ex його не знайшов би, повторний INSERT мовчки з'їв би 23505, і функція
        // кинула б «vanished after insert». Тож це пінить і читання, і запис.
        seen.space.push(await getOrCreateSpace({ type: "user", refId: userRef }, tx));
        seen.space.push(await getOrCreateSpace({ type: "user", refId: userRef }, tx));
        seen.note.push(await getOrCreateTopicNote(spaceId, topic, tx));
        seen.note.push(await getOrCreateTopicNote(spaceId, topic, tx));
        await retireProjectSpace(PROJ, tx);
        throw boom;
      })
      .then(() => null, (e: unknown) => e);

    expect(err).toBe(boom);
    expect(new Set(seen.space).size).toBe(1);
    expect(new Set(seen.note).size).toBe(1);

    // Жоден стейтмент не втік на модульний `db`: такий закоммітився б сам по собі
    // й пережив би відкат. Це єдина перевірка, яка ловить підміну ex → db, і без
    // неї Task 4/5/6 тихо втратили б атомарність.
    expect(await count("spaces", "type = 'user' AND ref_id = $1", [userRef])).toBe(0);
    expect(await count("vault_notes", "space_id = $1", [spaceId])).toBe(0);
    expect(await count("audit_events", "space_id = $1", [spaceId])).toBe(0);
    // А клейм, який retire видалив усередині транзакції, повернувся на місце.
    expect(await count("vault_claims", "id = $1", [claim])).toBe(1);
  });

  it("purge зносить простори користувача І давно retired-проєкту", async () => {
    const victim = `${P}victim`;
    await mkUser(victim);
    const userSpace = await getOrCreateSpace({ type: "user", refId: victim });
    const goneProject = `${P}gone-proj`;
    const projSpace = await getOrCreateSpace({ type: "project", refId: goneProject, ownerUserId: victim });
    // Проєкт видалено давно: рядка projects вже немає, простір лишався retired.
    await retireProjectSpace(goneProject);
    const chainU = await mkChain(userSpace, "purgeu");
    const chainP = await mkChain(projSpace, "purgep");
    await mkClaim(`${P}claim3`, userSpace);

    // Рівно те, що робить DELETE-хендлер адмінки: каскад users знімає чати →
    // повідомлення → цитати, і аж тоді простори нічим не запінені.
    await db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.id, victim));
      await purgeUserSpaces(victim, tx);
    });

    expect(await count('"user"', "id = $1", [victim])).toBe(0);
    expect(await count("spaces", "owner_user_id = $1", [victim])).toBe(0);
    expect(await count("knowledge_sources", "id = ANY($1)", [[chainU.source, chainP.source]])).toBe(0);
    expect(await count("knowledge_fragments", "id = ANY($1)", [[chainU.fragment, chainP.fragment]])).toBe(0);
    expect(await count("vault_claims", "space_id = $1", [userSpace])).toBe(0);
  });

  it("жива цитата відкочує УСЮ транзакцію purge: користувач лишається", async () => {
    const victim = `${P}pinned-victim`;
    await mkUser(victim);
    const space = await getOrCreateSpace({ type: "user", refId: victim });
    const { source, version, fragment } = await mkChain(space, "pin");
    // Аномалія: цитата висить у чаті ІНШОГО користувача, тож каскад victim'а її
    // не зносить і RESTRICT спрацьовує.
    await mkCitation("pin", version, fragment);

    const err = await db
      .transaction(async (tx) => {
        await tx.delete(users).where(eq(users.id, victim));
        await purgeUserSpaces(victim, tx);
      })
      .then(() => null, (e: unknown) => e);

    // drizzle ≥0.36 обгортає помилку драйвера — code живе на e АБО на e.cause.
    const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
    expect(code).toBe(FK_VIOLATION);

    // Відкотилось УСЕ, а не лише видалення простору: інакше адмін бачив би
    // помилку при вже знищеному користувачі.
    expect(await count('"user"', "id = $1", [victim])).toBe(1);
    expect(await count("spaces", "id = $1", [space])).toBe(1);
    expect(await count("knowledge_sources", "id = $1", [source])).toBe(1);
    expect(await count("knowledge_fragments", "id = $1", [fragment])).toBe(1);
  });
});
