import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Сервіс клеймів існує заради трьох речей, і жодну з них не можна перевірити без
 * справжнього Postgres: CAS-крок, який серіалізує два одночасні supersede на
 * блокуванні рядка; два партіальні unique-індекси, які ловлять розгалуження;
 * і атомарність ходу всередині ЧУЖОЇ транзакції. In-memory дубль перевіряв би
 * власну уяву про кожну з них.
 */
import { db, pool } from "@/lib/db";
import { auditEvents } from "@/lib/db/schema";
import type { Ex } from "../spaces";
import {
  createClaim,
  updateClaim,
  forgetClaim,
  attachEvidence,
  listHeadClaims,
  headBySlot,
  findCurrentHead,
  type Actor,
} from "../claims";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Префікс фікстур: усе прибирається одним DELETE по просторах (каскад зносить
 *  клейми з їхніми nanoid-ами, ноти, прив'язки, докази й аудит). */
const P = "clmtest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`; // «мій» простір
const SPACE_B = `${P}space-b`; // чужий: перевіряє authz
const NOTE_A = `${P}note-a`;
const ACTOR: Actor = { kind: "user", id: OWNER };

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const count = async (table: string, where: string, params: unknown[]) => {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].n);
};

const claimRow = async (id: string) => {
  const { rows } = await pool.query<{
    statement: string;
    slot_key: string | null;
    value: unknown;
    kind: string;
    origin: Record<string, unknown>;
    review_status: string;
    sensitive: boolean;
    revision: number;
    supersedes: string | null;
    superseded_at: Date | null;
  }>(`SELECT * FROM vault_claims WHERE id = $1`, [id]);
  return rows[0];
};

/** Розгалуження ланцюга: два рядки з тим самим supersedes. Партіальний unique
 *  `uniq_vclaims_one_successor` мусить робити це неможливим — тест дивиться на
 *  результат, а не на індекс. */
const branchedChains = async (spaceId: string) => {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT supersedes FROM vault_claims
       WHERE space_id = $1 AND supersedes IS NOT NULL
       GROUP BY supersedes HAVING count(*) > 1
     ) branched`,
    [spaceId],
  );
  return Number(rows[0].n);
};

/** users.email теж unique — таргетований ON CONFLICT (id) кинув би 23505 на
 *  залишковому рядку з тим самим email, а це виглядало б як skipped-тест. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'claims test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

const fixtures = async () => {
  await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'user', $2, $2)`, [SPACE_A, OWNER]);
  await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'project', $2, $3)`, [
    SPACE_B,
    `${P}proj`,
    OWNER,
  ]);
  await q(`INSERT INTO vault_notes (id, space_id, title, kind) VALUES ($1, $2, 'Тема', 'memory_topic')`, [
    NOTE_A,
    SPACE_A,
  ]);
};

/** Клейм-фікстура: створюється сервісом, бо саме його вихід і є входом решти. */
const seed = (over: Partial<Parameters<typeof createClaim>[0]> = {}) =>
  createClaim(
    {
      spaceId: SPACE_A,
      statement: "початковий факт",
      origin: { type: "chat" },
      reviewStatus: "unverified",
      ...over,
    },
    ACTOR,
  );

/** tx, який кидає рівно на вставці аудит-події — тобто ПІСЛЯ вставки наступника
 *  й переносу прив'язок. Проксі, а не spyOn на хендлі: drizzle тримає внутрішні
 *  поля під символами, тож підміняється лише один метод, решта йде до оригіналу. */
const failOnAuditInsert = <T extends object>(tx: T, boom: Error): T =>
  new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop !== "insert") return typeof value === "function" ? value.bind(target) : value;
      return (table: unknown) => {
        if (table === auditEvents) throw boom;
        return (value as (t: unknown) => unknown).call(target, table);
      };
    },
  });

run("vault claims", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(async () => {
    await cleanup();
    await fixtures();
  });

  it("createClaim пише клейм, прив'язку до теми і подію claim.create", async () => {
    const { id, revision } = await seed({
      statement: "Улюблена кава — фільтр",
      slotKey: "coffee",
      value: { drink: "filter" },
      reviewStatus: "confirmed",
      sensitive: true,
      topicNoteId: NOTE_A,
    });

    expect(revision).toBe(1);
    const row = await claimRow(id);
    expect(row.statement).toBe("Улюблена кава — фільтр");
    expect(row.slot_key).toBe("coffee");
    expect(row.value).toEqual({ drink: "filter" });
    expect(row.origin).toEqual({ type: "chat" });
    expect(row.review_status).toBe("confirmed");
    expect(row.sensitive).toBe(true);
    expect(row.revision).toBe(1);
    expect(row.supersedes).toBeNull();
    expect(row.superseded_at).toBeNull();

    expect(await count("note_claims", "note_id = $1 AND claim_id = $2", [NOTE_A, id])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.create' AND subject_id = $2", [SPACE_A, id])).toBe(1);
    // Текст чутливого клейма не має жити ще й в аудиті.
    const { rows } = await pool.query<{ payload: unknown }>(`SELECT payload FROM audit_events WHERE subject_id = $1`, [id]);
    expect(JSON.stringify(rows[0].payload)).not.toContain("фільтр");
  });

  it("supersede: старий рядок лишається з текстом, новий несе supersedes і +1 ревізію", async () => {
    const { id: oldId } = await seed({
      statement: "Працює в Києві",
      slotKey: "city",
      value: { city: "Kyiv" },
      reviewStatus: "confirmed",
      sensitive: true,
      topicNoteId: NOTE_A,
    });

    const res = await updateClaim({
      claimId: oldId,
      expectedRevision: 1,
      patch: { statement: "Працює у Львові", value: { city: "Lviv" } },
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.revision).toBe(2);

    // Текст попередника НІКОЛИ не UPDATE-иться — історія читається дослівно.
    const prev = await claimRow(oldId);
    expect(prev.statement).toBe("Працює в Києві");
    expect(prev.superseded_at).not.toBeNull();
    expect(prev.revision).toBe(1);

    const next = await claimRow(res.id);
    expect(next.statement).toBe("Працює у Львові");
    expect(next.value).toEqual({ city: "Lviv" });
    expect(next.supersedes).toBe(oldId);
    expect(next.revision).toBe(2);
    expect(next.superseded_at).toBeNull();
    // origin/sensitive/reviewStatus копіюються з попередника, а не скидаються.
    expect(next.origin).toEqual({ type: "chat" });
    expect(next.sensitive).toBe(true);
    expect(next.review_status).toBe("confirmed");
    // Слот не патчили — успадкований, і активна голова слоту тепер наступник.
    expect(next.slot_key).toBe("city");

    // Прив'язку до теми перенесено: стара її не тримає, нова тримає.
    expect(await count("note_claims", "claim_id = $1", [oldId])).toBe(0);
    expect(await count("note_claims", "note_id = $1 AND claim_id = $2", [NOTE_A, res.id])).toBe(1);

    expect(
      await count("audit_events", "space_id = $1 AND action = 'claim.supersede' AND subject_id = $2", [SPACE_A, oldId]),
    ).toBe(1);
  });

  it("mismatch ревізії: нуль слідів — ні наступника, ні події, ні дотику до рядка", async () => {
    const { id } = await seed({ slotKey: "mismatch", topicNoteId: NOTE_A });

    const res = await updateClaim({
      claimId: id,
      expectedRevision: 7,
      patch: { statement: "не має статись" },
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // Ланцюг живий і незайманий, тож програвший бачить актуальну голову.
    expect(res.current?.id).toBe(id);
    expect(res.current?.revision).toBe(1);

    const row = await claimRow(id);
    expect(row.superseded_at).toBeNull();
    expect(row.statement).toBe("початковий факт");
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(0);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.supersede'", [SPACE_A])).toBe(0);
    expect(await count("note_claims", "claim_id = $1", [id])).toBe(1);
  });

  it("ГОНКА update/update: рівно один ok і РІВНО одна активна голова", async () => {
    const { id } = await seed({ statement: "початок", slotKey: "race" });
    const attempt = (statement: string) =>
      updateClaim({
        claimId: id,
        expectedRevision: 1,
        patch: { statement },
        allowedSpaceIds: [SPACE_A],
        actor: ACTOR,
      });

    // Жодної черги: обидві транзакції стартують одночасно й серіалізуються
    // виключно на блокуванні рядка в CAS-кроці.
    const settled = await Promise.allSettled([attempt("гілка A"), attempt("гілка B")]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    // Програвший не мовчить: він бачить голову, яку щойно поставив переможець.
    expect(loser && !loser.ok && loser.current?.revision).toBe(2);

    // Голову рахуємо з БАЗИ, а не з повернених значень.
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(1);
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(1);
    expect(await branchedChains(SPACE_A)).toBe(0);
  });

  it("ГОНКА update/forget: переможець один, розгалуження немає", async () => {
    const { id } = await seed({ statement: "спірне", slotKey: "race2" });

    const settled = await Promise.allSettled([
      updateClaim({
        claimId: id,
        expectedRevision: 1,
        patch: { statement: "оновлене" },
        allowedSpaceIds: [SPACE_A],
        actor: ACTOR,
      }),
      forgetClaim({ claimId: id, expectedRevision: 1, allowedSpaceIds: [SPACE_A], actor: ACTOR, reason: "застаріле" }),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const [upd, forget] = settled.map((s) => (s.status === "fulfilled" ? s.value : null));

    expect([upd?.ok, forget?.ok].filter(Boolean)).toHaveLength(1);
    const updateWon = upd?.ok === true;

    // Переміг update — лишилась одна голова; переміг forget — жодної.
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(updateWon ? 1 : 0);
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(updateWon ? 1 : 0);
    expect(await branchedChains(SPACE_A)).toBe(0);
    // Рівно одна подія на ланцюг: програвший нічого не пише.
    expect(await count("audit_events", "space_id = $1 AND action IN ('claim.supersede','claim.forget')", [SPACE_A])).toBe(1);
    expect(await findCurrentHead(id)).toEqual(updateWon ? expect.objectContaining({ revision: 2 }) : null);
  });

  it("authz: чужий простір дає {ok:false, current:null} без витоку тексту", async () => {
    const secret = "таємниця чужого простору";
    const foreign = await createClaim(
      { spaceId: SPACE_B, statement: secret, slotKey: "secret", origin: {}, reviewStatus: "confirmed" },
      ACTOR,
    );

    const upd = await updateClaim({
      claimId: foreign.id,
      expectedRevision: 1,
      patch: { statement: "спроба" },
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    const forget = await forgetClaim({
      claimId: foreign.id,
      expectedRevision: 1,
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });

    // Рівно та сама відповідь, що й на «ланцюг закінчено forget-ом»: із неї не
    // видно навіть того, що клейм існує.
    expect(upd).toEqual({ ok: false, current: null });
    expect(forget).toEqual({ ok: false, current: null });
    expect(JSON.stringify([upd, forget])).not.toContain(secret);
    // Прямий запит з чужим фільтром теж мовчить.
    expect(await findCurrentHead(foreign.id, [SPACE_A])).toBeNull();
    // ...а зі своїм — ні, інакше тест був би зелений на зламаному лукапі.
    expect((await findCurrentHead(foreign.id, [SPACE_B]))?.statement).toBe(secret);

    // Порожній список просторів — теж «нічого», а не «усе».
    expect(await findCurrentHead(foreign.id, [])).toBeNull();

    // І нічого не зачеплено.
    const row = await claimRow(foreign.id);
    expect(row.superseded_at).toBeNull();
    expect(await count("audit_events", "space_id = $1 AND action <> 'claim.create'", [SPACE_B])).toBe(0);
  });

  // Дві форми виклику, один результат: `Ex` дозволяє передати модульний `db`
  // ЯВНО, і це пул, а не транзакція. Якби сервіс відкривав власну транзакцію
  // лише на відсутність аргументу, колер, який передав `db` «щоб було», тихо
  // писав би чотири окремі стейтменти замість ходу.
  it.each([
    ["ex не передано", undefined],
    ["ex === db, тобто пул", db],
  ] as const)("атомарність (%s): збій після вставки наступника відкочує ВЕСЬ хід", async (_label, passed) => {
    const { id } = await seed({ statement: "до збою", slotKey: "atomic", topicNoteId: NOTE_A });

    const boom = new Error("збій після наступника");
    const realTransaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation((async (cb: (tx: Ex) => Promise<unknown>) =>
      realTransaction((tx) => cb(failOnAuditInsert(tx, boom)))) as unknown as typeof db.transaction);

    try {
      await expect(
        updateClaim(
          {
            claimId: id,
            expectedRevision: 1,
            patch: { statement: "після збою" },
            allowedSpaceIds: [SPACE_A],
            actor: ACTOR,
          },
          passed,
        ),
      ).rejects.toBe(boom);
    } finally {
      spy.mockRestore();
    }

    // Відкотилось УСЕ: і CAS, і наступник, і перенос прив'язки.
    const row = await claimRow(id);
    expect(row.superseded_at).toBeNull();
    expect(row.statement).toBe("до збою");
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(0);
    expect(await count("note_claims", "claim_id = $1", [id])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.supersede'", [SPACE_A])).toBe(0);
    // Сервіс лишився робочим — спай знято, а не «зафіксовано» назавжди.
    const retry = await updateClaim({
      claimId: id,
      expectedRevision: 1,
      patch: { statement: "після відкату" },
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(retry.ok).toBe(true);
  });

  it("ланцюг із 5 версій: findCurrentHead знаходить голову з будь-якої ланки", async () => {
    const first = await seed({ statement: "версія 1", slotKey: "chain" });
    const chain = [first.id];
    let cur = first;
    for (let i = 2; i <= 5; i++) {
      const res = await updateClaim({
        claimId: cur.id,
        expectedRevision: cur.revision,
        patch: { statement: `версія ${i}` },
        allowedSpaceIds: [SPACE_A],
        actor: ACTOR,
      });
      if (!res.ok) throw new Error(`ланка ${i} не пройшла`);
      cur = { id: res.id, revision: res.revision };
      chain.push(res.id);
    }
    expect(cur.revision).toBe(5);

    for (const link of chain) {
      const head = await findCurrentHead(link, [SPACE_A]);
      expect(head?.id).toBe(cur.id);
      expect(head?.revision).toBe(5);
      expect(head?.statement).toBe("версія 5");
    }
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(1);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(5);
  });

  it("forget: наступника немає, докази й прив'язки лишаються, голови немає", async () => {
    const { id } = await seed({ statement: "забудь мене", slotKey: "forget", topicNoteId: NOTE_A });
    await attachEvidence(id, { relation: "supports", messageId: `${P}msg`, quoteSnapshot: "цитата" });

    const res = await forgetClaim({
      claimId: id,
      expectedRevision: 1,
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
      reason: "користувач попросив",
    });
    expect(res).toEqual({ ok: true });

    const row = await claimRow(id);
    expect(row.superseded_at).not.toBeNull();
    expect(row.statement).toBe("забудь мене");
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(0);
    // Історія ціла: докази й прив'язки лишаються на неактивному рядку.
    expect(await count("claim_evidence", "claim_id = $1 AND relation = 'supports'", [id])).toBe(1);
    expect(await count("note_claims", "claim_id = $1", [id])).toBe(1);

    expect(await findCurrentHead(id, [SPACE_A])).toBeNull();
    expect(await headBySlot(SPACE_A, "forget")).toBeNull();
    expect(await listHeadClaims(SPACE_A)).toEqual([]);

    const { rows } = await pool.query<{ payload: { reason?: string } }>(
      `SELECT payload FROM audit_events WHERE action = 'claim.forget' AND subject_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.reason).toBe("користувач попросив");
  });

  it("update ПІСЛЯ forget: {ok:false, current:null} і жодного нового рядка", async () => {
    const { id } = await seed({ statement: "уже забуте", slotKey: "gone" });
    expect(await forgetClaim({ claimId: id, expectedRevision: 1, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({
      ok: true,
    });

    const res = await updateClaim({
      claimId: id,
      expectedRevision: 1,
      patch: { statement: "воскресіння" },
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(res).toEqual({ ok: false, current: null });
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.supersede'", [SPACE_A])).toBe(0);
  });

  it("listHeadClaims: лише голови, ORDER BY recorded_at DESC, id — і фільтри", async () => {
    const c1 = await seed({ statement: "перший", slotKey: "s1", reviewStatus: "confirmed", topicNoteId: NOTE_A });
    const c2 = await seed({ statement: "другий", slotKey: "s2", topicNoteId: NOTE_A });
    const c3 = await seed({ statement: "третій", reviewStatus: "confirmed" });
    const upd = await updateClaim({
      claimId: c2.id,
      expectedRevision: 1,
      patch: { statement: "другий, версія 2" },
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!upd.ok) throw new Error("unreachable");
    const sorted = (ids: string[]) => [...ids].sort();

    // Різні recorded_at: перший ключ — спадний, тож наступник (наймолодший) іде
    // першим, а найстаріший клейм — останнім.
    await q(`UPDATE vault_claims SET recorded_at = '2026-01-01 00:00:00' WHERE id = $1`, [c1.id]);
    await q(`UPDATE vault_claims SET recorded_at = '2026-01-02 00:00:00' WHERE id = $1`, [c3.id]);
    await q(`UPDATE vault_claims SET recorded_at = '2026-01-03 00:00:00' WHERE id = $1`, [upd.id]);
    expect((await listHeadClaims(SPACE_A)).map((h) => h.id)).toEqual([upd.id, c3.id, c1.id]);

    // Рівний recorded_at — звичайна ситуація, коли міграція пише пачку клеймів
    // однією транзакцією. Тоді порядок тримає ЛИШЕ другий ключ, і без нього
    // маніфест плану A не був би байт-у-байт стабільним. Контроль рахує сам
    // Postgres: сортування text залежить від колації бази, тож JS-ний .sort()
    // тут був би іншим порядком, а не тим самим.
    await q(`UPDATE vault_claims SET recorded_at = '2026-01-01 00:00:00' WHERE space_id = $1`, [SPACE_A]);
    const { rows: byId } = await pool.query<{ id: string }>(
      `SELECT id FROM vault_claims WHERE space_id = $1 AND superseded_at IS NULL ORDER BY id`,
      [SPACE_A],
    );
    const heads = await listHeadClaims(SPACE_A);
    expect(heads.map((h) => h.id)).toEqual(byId.map((r) => r.id));
    expect(sorted(heads.map((h) => h.id))).toEqual(sorted([c1.id, c3.id, upd.id]));
    expect(heads.map((h) => h.statement)).toContain("другий, версія 2");

    expect((await listHeadClaims(SPACE_A, { slotKey: "s1" })).map((h) => h.id)).toEqual([c1.id]);
    const confirmed = await listHeadClaims(SPACE_A, { onlyConfirmed: true });
    expect(sorted(confirmed.map((h) => h.id))).toEqual(sorted([c1.id, c3.id]));
    // Прив'язка переїхала на наступника, тож фільтр по темі бачить саме його.
    const byTopic = await listHeadClaims(SPACE_A, { topicNoteId: NOTE_A });
    expect(sorted(byTopic.map((h) => h.id))).toEqual(sorted([c1.id, upd.id]));
    // Чужий простір порожній — фільтр по простору не «протікає».
    expect(await listHeadClaims(SPACE_B)).toEqual([]);

    const bySlot = await headBySlot(SPACE_A, "s2");
    expect(bySlot?.id).toBe(upd.id);
    expect(bySlot?.revision).toBe(2);
    expect(await headBySlot(SPACE_A, "немає такого слоту")).toBeNull();
  });

  it("усі функції читають і пишуть ЧЕРЕЗ переданий ex", async () => {
    // Стан ДО транзакції: три закомічені клейми, один із них прив'язаний до
    // теми. Кожен запис усередині транзакції має закомічений рядок, який він міг
    // би зачепити, — інакше «нічого не лишилось» нічого й не доводить.
    const upd = await seed({ statement: "для оновлення", slotKey: "ex-upd", topicNoteId: NOTE_A });
    const forget = await seed({ statement: "для забуття", slotKey: "ex-forget" });
    const evidence = await seed({ statement: "для доказу", slotKey: "ex-evidence" });

    const boom = new Error("rollback");
    const seen: Record<string, unknown> = {};
    const err = await db
      .transaction(async (tx) => {
        const created = await createClaim(
          {
            spaceId: SPACE_A,
            statement: "створено в транзакції",
            slotKey: "ex-created",
            origin: {},
            reviewStatus: "unverified",
            topicNoteId: NOTE_A,
          },
          ACTOR,
          tx,
        );
        // Читання теж мусить іти через ex: повз нього незакомічений рядок не
        // видно, і це впало б тут, а не тихо роз'їхалось у Task 5.
        seen.bySlot = (await headBySlot(SPACE_A, "ex-created", tx))?.id;

        const superseded = await updateClaim(
          {
            claimId: upd.id,
            expectedRevision: 1,
            patch: { statement: "оновлено в транзакції" },
            allowedSpaceIds: [SPACE_A],
            actor: ACTOR,
          },
          tx,
        );
        if (!superseded.ok) throw new Error("CAS не мав програти");
        seen.head = (await findCurrentHead(upd.id, [SPACE_A], tx))?.id;
        seen.expectedHead = superseded.id;

        await forgetClaim({ claimId: forget.id, expectedRevision: 1, allowedSpaceIds: [SPACE_A], actor: ACTOR }, tx);
        await attachEvidence(evidence.id, { messageId: `${P}msg`, quoteSnapshot: "доказ" }, tx);

        seen.listed = (await listHeadClaims(SPACE_A, {}, tx)).map((h) => h.id).includes(forget.id);
        seen.createdId = created.id;
        throw boom;
      })
      .then(() => null, (e: unknown) => e);

    expect(err).toBe(boom);
    expect(seen.bySlot).toBe(seen.createdId);
    expect(seen.head).toBe(seen.expectedHead);
    expect(seen.listed).toBe(false);

    // Жоден стейтмент не втік на модульний `db`: такий закомітився б сам по собі
    // й пережив би відкат. Це єдина перевірка, яка ловить підміну ex → db.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(3);
    expect(await count("vault_claims", "supersedes IS NOT NULL", [])).toBe(0);
    expect(await count("vault_claims", "id = $1 AND superseded_at IS NULL", [upd.id])).toBe(1);
    expect(await count("vault_claims", "id = $1 AND superseded_at IS NULL", [forget.id])).toBe(1);
    expect(await count("note_claims", "note_id = $1", [NOTE_A])).toBe(1);
    expect(await count("note_claims", "claim_id = $1", [upd.id])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [evidence.id])).toBe(0);
    // Три create-події від фікстур закомічені до транзакції; усередині не мало
    // додатись жодної.
    expect(await count("audit_events", "space_id = $1", [SPACE_A])).toBe(3);
  });
});
