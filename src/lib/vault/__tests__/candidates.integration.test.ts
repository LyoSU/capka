import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Реєстр кандидатів — єдиний вхід у пам'ять, і три його властивості не існують
 * поза справжнім Postgres: партіальний unique на слот, який перетворює гонку двох
 * пропозицій на 23505; SAVEPOINT, без якого цей 23505 абортить УСЮ транзакцію
 * (тобто відновлення неможливе за побудовою); і CAS на `memory_candidates`, який
 * арбітрує confirm/confirm та confirm/reject. In-memory дубль перевіряв би власну
 * уяву про кожну з трьох.
 */

/** Керування моками живе в hoisted-об'єкті: фабрика `vi.mock` підіймається над
 *  імпортами, тож звичайний `const` тут дав би TDZ. За замовчуванням обидва
 *  важелі вимкнені — модуль працює справжній. */
const ctl = vi.hoisted(() => ({
  casLosses: 0,
  createError: null as unknown,
  beforeCreate: null as null | (() => Promise<void>),
}));

vi.mock("../claims", async (importOriginal) => {
  const real = await importOriginal<typeof import("../claims")>();
  return {
    ...real,
    createClaim: async (...args: Parameters<typeof real.createClaim>) => {
      if (ctl.createError) throw ctl.createError;
      // Вікно «конкурент закомітився МІЖ нашим headBySlot і нашою вставкою» —
      // єдиний спосіб детерміновано відтворити 23505 на слоті.
      const hook = ctl.beforeCreate;
      ctl.beforeCreate = null;
      if (hook) await hook();
      return real.createClaim(...args);
    },
    updateClaim: (...args: Parameters<typeof real.updateClaim>) => {
      if (ctl.casLosses > 0) {
        ctl.casLosses--;
        return Promise.resolve({ ok: false as const, current: null });
      }
      return real.updateClaim(...args);
    },
  };
});

import { pool } from "@/lib/db";
import { createClaim, type Actor } from "../claims";
import {
  proposeCandidate,
  confirmCandidate,
  rejectCandidate,
  listOpenCandidates,
  verifyDirectProvenance,
  type Provenance,
} from "../candidates";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Префікс фікстур: усе прибирається одним DELETE по просторах (каскад зносить
 *  кандидатів, клейми, ноти, прив'язки, докази й аудит). */
const P = "candtest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`; // «мій» простір
const SPACE_B = `${P}space-b`; // чужий: перевіряє authz
const NOTE_A = `${P}note-a`;
const ACTOR: Actor = { kind: "user", id: OWNER };
const DIRECT: Provenance = { kind: "user_direct", messageId: `${P}msg` };

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const count = async (table: string, where: string, params: unknown[]) => {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].n);
};

const candRow = async (id: string) => {
  const { rows } = await pool.query<{
    id: string;
    policy_state: string;
    claim_id: string | null;
    conflicts_with: string | null;
    resolved_at: Date | null;
    evidence: unknown;
    sensitive: boolean;
    slot_key: string | null;
    provenance: Record<string, unknown>;
  }>(`SELECT * FROM memory_candidates WHERE id = $1`, [id]);
  return rows[0];
};

const claimRow = async (id: string) => {
  const { rows } = await pool.query<{
    statement: string;
    slot_key: string | null;
    value: unknown;
    origin: Record<string, unknown>;
    review_status: string;
    sensitive: boolean;
    revision: number;
    supersedes: string | null;
    superseded_at: Date | null;
  }>(`SELECT * FROM vault_claims WHERE id = $1`, [id]);
  return rows[0];
};

/** Прив'язка клейма до теми «Загальне» — рівно те, що читає GET Task 10. */
const inDefaultTopic = async (claimId: string) =>
  count(
    "note_claims nc JOIN vault_notes n ON n.id = nc.note_id",
    "nc.claim_id = $1 AND n.title = 'Загальне' AND n.kind = 'memory_topic' AND n.space_id = $2",
    [claimId, SPACE_A],
  );

/** users.email теж unique — таргетований ON CONFLICT (id) кинув би 23505 на
 *  залишковому рядку з тим самим email, а це виглядало б як skipped-тест. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'candidates test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
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

let seq = 0;
/** Ключ ідемпотентності унікальний на виклик, якщо тест не задає його явно —
 *  інакше другий propose у тому самому тесті мовчки ставав би `duplicate`. */
const propose = (over: Partial<Parameters<typeof proposeCandidate>[0]> = {}) =>
  proposeCandidate({
    idempotencyKey: `${P}idem-${++seq}`,
    spaceId: SPACE_A,
    statement: "факт за замовчуванням",
    provenance: DIRECT,
    ...over,
  });

run("vault candidates", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(async () => {
    ctl.casLosses = 0;
    ctl.createError = null;
    ctl.beforeCreate = null;
    await cleanup();
    await fixtures();
  });

  /** Конкурент, який комітиться ОКРЕМИМ з'єднанням (pool = autocommit), поки наша
   *  зовнішня транзакція відкрита: рівно та ситуація, у якій вставка клейма
   *  ловить справжній 23505 від Postgres, а не змодельований. */
  const competitorTakesSlot = (slotKey: string, statement: string) => {
    const id = `${P}rival-${slotKey}`;
    ctl.beforeCreate = async () => {
      await q(
        `INSERT INTO vault_claims (id, space_id, statement, slot_key, origin, review_status)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'confirmed')`,
        [id, SPACE_A, statement, slotKey],
      );
    };
    return id;
  };

  it("конкурент забрав слот МІЖ прочитом і вставкою: 23505 гаситься SAVEPOINT → merged", async () => {
    const rival = competitorTakesSlot("det-merge", "Живе в Одесі");

    const res = await propose({
      statement: "живе   в одесі",
      slotKey: "det-merge",
      evidence: [{ messageId: `${P}msg` }],
    });

    // Назовні unique violation НЕ вилітає — саме заради цього існує SAVEPOINT.
    expect(res).toEqual({ state: "merged", claimId: rival });
    // Наш клейм відкотився разом із савпоінтом; голова одна — конкурентова.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [rival])).toBe(1);
    // Зовнішня транзакція ПЕРЕЖИЛА помилку: рядок кандидата закомічений.
    expect(await count("memory_candidates", "space_id = $1 AND resolved_at IS NOT NULL AND claim_id = $2", [SPACE_A, rival])).toBe(1);
  });

  it("конкурент забрав слот іншим текстом: 23505 гаситься SAVEPOINT → conflict", async () => {
    const rival = competitorTakesSlot("det-conflict", "Живе в Одесі");

    const res = await propose({ statement: "Живе в Харкові", slotKey: "det-conflict" });
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") throw new Error("unreachable");

    const cand = await candRow(res.candidateId);
    expect(cand.conflicts_with).toBe(rival);
    expect(cand.resolved_at).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("user_direct активується: клейм confirmed, тема «Загальне», кандидат закритий", async () => {
    const res = await propose({
      statement: "Улюблена кава — фільтр",
      slotKey: "coffee",
      value: { drink: "filter" },
      evidence: [{ messageId: `${P}msg`, quoteSnapshot: "кава — фільтр" }],
    });

    expect(res.state).toBe("auto_active");
    if (res.state !== "auto_active") throw new Error("unreachable");
    expect(res.revision).toBe(1);

    const claim = await claimRow(res.claimId);
    expect(claim.statement).toBe("Улюблена кава — фільтр");
    expect(claim.slot_key).toBe("coffee");
    expect(claim.value).toEqual({ drink: "filter" });
    expect(claim.origin).toEqual({ kind: "user_direct", messageId: `${P}msg` });
    // Контракт Task 8: маніфест перелічує лише confirmed — unverified зробив би
    // щойно збережений факт невидимим при формально «робочому» ходi.
    expect(claim.review_status).toBe("confirmed");
    expect(claim.superseded_at).toBeNull();

    // Контракт Task 10: GET проєктує тему — клейм без теми теж невидимий.
    expect(await inDefaultTopic(res.claimId)).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [res.claimId])).toBe(1);

    const [cand] = (await q(`SELECT * FROM memory_candidates WHERE space_id = $1`, [SPACE_A])).rows as {
      policy_state: string;
      claim_id: string | null;
      resolved_at: Date | null;
    }[];
    expect(cand.policy_state).toBe("auto_active");
    expect(cand.claim_id).toBe(res.claimId);
    expect(cand.resolved_at).not.toBeNull();

    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.propose'", [SPACE_A])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.create'", [SPACE_A])).toBe(1);
  });

  it("явний topicNoteId поважається замість «Загального»", async () => {
    const res = await propose({ statement: "факт у своїй темі", topicNoteId: NOTE_A });
    if (res.state !== "auto_active") throw new Error("expected auto_active");

    expect(await count("note_claims", "note_id = $1 AND claim_id = $2", [NOTE_A, res.claimId])).toBe(1);
    expect(await inDefaultTopic(res.claimId)).toBe(0);
    // Тему «Загальне» навіть не створювали.
    expect(await count("vault_notes", "space_id = $1 AND title = 'Загальне'", [SPACE_A])).toBe(0);
  });

  it("sensitive → pending: клейма немає, докази чекають у jsonb", async () => {
    const res = await propose({
      statement: "Зарплата — 100500",
      sensitive: true,
      evidence: [{ messageId: `${P}msg`, quoteSnapshot: "зарплата" }],
    });

    expect(res.state).toBe("pending");
    if (res.state !== "pending") throw new Error("unreachable");
    const cand = await candRow(res.candidateId);
    expect(cand.policy_state).toBe("pending");
    expect(cand.claim_id).toBeNull();
    expect(cand.resolved_at).toBeNull();
    expect(cand.sensitive).toBe(true);
    expect(cand.evidence).toEqual([{ messageId: `${P}msg`, quoteSnapshot: "зарплата" }]);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
  });

  it("будь-який kind, крім user_direct, → pending", async () => {
    const kinds: Provenance["kind"][] = ["derived", "tool", "file", "web", "legacy_memory_doc"];
    for (const kind of kinds) {
      const res = await propose({ statement: `факт із ${kind}`, provenance: { kind } });
      expect([kind, res.state]).toEqual([kind, "pending"]);
    }
    // Жоден із них не створив клейма — саме це й ловить ін'єкцію через тул.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
    expect(await count("memory_candidates", "space_id = $1 AND resolved_at IS NULL", [SPACE_A])).toBe(kinds.length);
  });

  it("forceState:'conflict' б'є навіть user_direct", async () => {
    const res = await propose({ statement: "спірне", slotKey: "slot-x", forceState: "conflict" });
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") throw new Error("unreachable");
    const cand = await candRow(res.candidateId);
    expect(cand.policy_state).toBe("conflict");
    expect(cand.resolved_at).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
  });

  it("той самий idempotencyKey — ПОВНИЙ no-op: ні рядка, ні події", async () => {
    const key = `${P}idem-fixed`;
    const first = await propose({ idempotencyKey: key, statement: "факт один раз" });
    expect(first.state).toBe("auto_active");

    const before = {
      cands: await count("memory_candidates", "space_id = $1", [SPACE_A]),
      claims: await count("vault_claims", "space_id = $1", [SPACE_A]),
      audit: await count("audit_events", "space_id = $1", [SPACE_A]),
    };

    // Інший текст під тим самим ключем: відповідь усе одно «вже оброблено».
    const again = await propose({ idempotencyKey: key, statement: "зовсім інший факт" });
    expect(again).toEqual({ state: "duplicate" });

    expect(await count("memory_candidates", "space_id = $1", [SPACE_A])).toBe(before.cands);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(before.claims);
    expect(await count("audit_events", "space_id = $1", [SPACE_A])).toBe(before.audit);
  });

  it("зайнятий слот + той самий текст (інший регістр/пробіли) → merged, кандидат ЗАКРИТО", async () => {
    const first = await propose({ statement: "Працює в Києві", slotKey: "city" });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const res = await propose({
      statement: "  працює   в   києві ",
      slotKey: "city",
      evidence: [{ messageId: `${P}msg2`, quoteSnapshot: "в Києві" }],
    });
    expect(res).toEqual({ state: "merged", claimId: first.claimId });

    // Новий клейм НЕ створювався, доказ долився до наявної голови.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [first.claimId])).toBe(1);

    // Кандидат не лишається у черзі на підтвердження вже відомого факту.
    const { rows } = await pool.query<{ policy_state: string; claim_id: string | null; resolved_at: Date | null }>(
      `SELECT * FROM memory_candidates WHERE space_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [SPACE_A],
    );
    expect(rows[0].policy_state).toBe("auto_active");
    expect(rows[0].claim_id).toBe(first.claimId);
    expect(rows[0].resolved_at).not.toBeNull();
    expect(await count("memory_candidates", "space_id = $1 AND resolved_at IS NULL", [SPACE_A])).toBe(0);
  });

  it("зайнятий слот + інший текст → conflict із посиланням на голову", async () => {
    const first = await propose({ statement: "Працює в Києві", slotKey: "city" });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const res = await propose({ statement: "Працює у Львові", slotKey: "city" });
    expect(res.state).toBe("conflict");
    if (res.state !== "conflict") throw new Error("unreachable");

    const cand = await candRow(res.candidateId);
    expect(cand.policy_state).toBe("conflict");
    expect(cand.conflicts_with).toBe(first.claimId);
    expect(cand.claim_id).toBeNull();
    expect(cand.resolved_at).toBeNull();
    // Голова недоторкана: рішення за людиною.
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(1);
  });

  it("БЕЗ слота: дедуп за нормалізованим текстом серед голів простору", async () => {
    const first = await propose({ statement: "Має кота на ім'я Мурчик" });
    if (first.state !== "auto_active") throw new Error("expected auto_active");

    const dup = await propose({ statement: "має  кота   НА ім'я Мурчик  " });
    expect(dup).toEqual({ state: "merged", claimId: first.claimId });

    const other = await propose({ statement: "Має собаку" });
    expect(other.state).toBe("auto_active");
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(2);
  });

  it("ГОНКА двох propose на НЕзайнятий слот (той самий текст): один active, один merged", async () => {
    const attempt = (key: string) =>
      propose({ idempotencyKey: `${P}race-${key}`, statement: "Живе в Одесі", slotKey: "race-slot" });

    // Жодної черги: обидві транзакції стартують одночасно й серіалізуються
    // виключно на партіальному unique слоту.
    const settled = await Promise.allSettled([attempt("a"), attempt("b")]);
    // Назовні unique violation НЕ вилітає — це і є сенс SAVEPOINT.
    expect(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "fulfilled"))).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const states = settled
      .flatMap((s) => (s.status === "fulfilled" ? [s.value] : []))
      .map((r) => r.state)
      .sort();
    expect(states).toEqual(["auto_active", "merged"]);

    // Рівно одна активна голова в слоті — рахуємо з БАЗИ, не з відповідей.
    expect(await count("vault_claims", "space_id = $1 AND slot_key = 'race-slot' AND superseded_at IS NULL", [SPACE_A])).toBe(1);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    // Обидва кандидати закриті: жоден не завис у черзі.
    expect(await count("memory_candidates", "space_id = $1 AND resolved_at IS NULL", [SPACE_A])).toBe(0);
  });

  it("ГОНКА двох propose на НЕзайнятий слот (різні тексти): один active, один conflict", async () => {
    const attempt = (key: string, statement: string) =>
      propose({ idempotencyKey: `${P}race2-${key}`, statement, slotKey: "race-slot2" });

    const settled = await Promise.allSettled([attempt("a", "Живе в Одесі"), attempt("b", "Живе в Харкові")]);
    expect(settled.map((s) => (s.status === "rejected" ? String(s.reason) : "fulfilled"))).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    expect(results.map((r) => r.state).sort()).toEqual(["auto_active", "conflict"]);

    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    // Той, хто програв, лишився відкритим і вказує на переможця.
    const { rows } = await pool.query<{ conflicts_with: string | null }>(
      `SELECT conflicts_with FROM memory_candidates WHERE space_id = $1 AND policy_state = 'conflict'`,
      [SPACE_A],
    );
    expect(rows).toHaveLength(1);
    const { rows: heads } = await pool.query<{ id: string }>(
      `SELECT id FROM vault_claims WHERE space_id = $1 AND superseded_at IS NULL`,
      [SPACE_A],
    );
    expect(rows[0].conflicts_with).toBe(heads[0].id);
  });

  it("ЧУЖИЙ 23505 не ковтається: інший constraint летить назовні, транзакція відкочується", async () => {
    // Drizzle ≥0.36 обгортає помилку драйвера — код і constraint читаються з
    // `cause`. Тут і перевіряється, що звірка йде по ОБОХ полях, а не по коду.
    const boom = Object.assign(new Error("wrapped"), {
      cause: Object.assign(new Error("pg"), { code: "23505", constraint: "uniq_vclaims_one_successor" }),
    });
    ctl.createError = boom;

    await expect(propose({ statement: "не має дожити", slotKey: "foreign" })).rejects.toBe(boom);

    // Зовнішня транзакція відкотилась ЦІЛКОМ: рядка кандидата немає, тож
    // ідемпотентний ключ не спалений і пропозицію можна повторити.
    expect(await count("memory_candidates", "space_id = $1", [SPACE_A])).toBe(0);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(0);
    expect(await count("audit_events", "space_id = $1", [SPACE_A])).toBe(0);
  });

  it("confirm порожнього слота: клейм confirmed, тема «Загальне», збережений evidence долитий", async () => {
    const proposed = await propose({
      statement: "Дедлайн — понеділок",
      slotKey: "deadline",
      value: { day: "mon" },
      sensitive: true,
      evidence: [{ messageId: `${P}msg`, quoteSnapshot: "понеділок" }, { relation: "derived_from" }],
    });
    if (proposed.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: proposed.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const claim = await claimRow(res.claimId);
    expect(claim.statement).toBe("Дедлайн — понеділок");
    expect(claim.slot_key).toBe("deadline");
    expect(claim.value).toEqual({ day: "mon" });
    expect(claim.review_status).toBe("confirmed");
    // Чутливість кандидата переїжджає на клейм, а не губиться.
    expect(claim.sensitive).toBe(true);
    expect(await inDefaultTopic(res.claimId)).toBe(1);
    // Обидва докази з jsonb застосовані.
    expect(await count("claim_evidence", "claim_id = $1", [res.claimId])).toBe(2);

    const cand = await candRow(proposed.candidateId);
    expect(cand.claim_id).toBe(res.claimId);
    expect(cand.resolved_at).not.toBeNull();
    // policy_state лишається як був — перехід фіксує аудит.
    expect(cand.policy_state).toBe("pending");
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.confirm'", [SPACE_A])).toBe(1);
  });

  it("confirm при зайнятому слоті з тим самим текстом → merge у голову без нового клейма", async () => {
    const head = await propose({ statement: "Працює в Києві", slotKey: "city" });
    if (head.state !== "auto_active") throw new Error("expected auto_active");

    const pending = await propose({
      statement: "працює в києві",
      slotKey: "city",
      sensitive: true,
      evidence: [{ messageId: `${P}msg3` }],
    });
    if (pending.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res).toEqual({ ok: true, claimId: head.claimId });
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [head.claimId])).toBe(1);
  });

  it("confirm при зайнятому слоті з іншим текстом: стара голова superseded, нова active і confirmed", async () => {
    // Голова навмисно unverified: якби confirm лише копіював review_status
    // попередника, підтверджений факт лишився б невидимим для маніфесту.
    const old = await createClaim(
      {
        spaceId: SPACE_A,
        statement: "Працює в Києві",
        slotKey: "city",
        origin: { kind: "legacy_memory_doc" },
        reviewStatus: "unverified",
      },
      ACTOR,
    );

    const pending = await propose({ statement: "Працює у Львові", slotKey: "city", value: { city: "Lviv" }, sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const prev = await claimRow(old.id);
    expect(prev.superseded_at).not.toBeNull();
    expect(prev.statement).toBe("Працює в Києві");

    const next = await claimRow(res.claimId);
    expect(next.statement).toBe("Працює у Львові");
    expect(next.value).toEqual({ city: "Lviv" });
    expect(next.supersedes).toBe(old.id);
    expect(next.revision).toBe(2);
    expect(next.review_status).toBe("confirmed");
    expect(next.sensitive).toBe(true);
    expect(await count("vault_claims", "space_id = $1 AND slot_key = 'city' AND superseded_at IS NULL", [SPACE_A])).toBe(1);
  });

  it("ГОНКА confirm/confirm: рівно один ok, другий — already_resolved", async () => {
    const pending = await propose({ statement: "спірне підтвердження", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");
    const attempt = () =>
      confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });

    const settled = await Promise.allSettled([attempt(), attempt()]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "already_resolved" });
    // Один клейм, не два.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("ГОНКА confirm/reject: переможець один", async () => {
    const pending = await propose({ statement: "confirm проти reject", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    const settled = await Promise.allSettled([
      confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR }),
      rejectCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR }),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const [conf, rej] = settled.map((s) => (s.status === "fulfilled" ? s.value : null));

    expect([conf?.ok, rej?.ok].filter(Boolean)).toHaveLength(1);
    // Переміг confirm — є клейм; переміг reject — немає.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(conf?.ok ? 1 : 0);
    expect(
      await count("audit_events", "space_id = $1 AND action IN ('candidate.confirm','candidate.reject')", [SPACE_A]),
    ).toBe(1);
  });

  it("один програш CAS — один повтор, і він виграє", async () => {
    await createClaim(
      { spaceId: SPACE_A, statement: "стара голова", slotKey: "city", origin: {}, reviewStatus: "confirmed" },
      ACTOR,
    );
    const pending = await propose({ statement: "нова голова", slotKey: "city", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    ctl.casLosses = 1;
    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res.ok).toBe(true);
    expect(ctl.casLosses).toBe(0);
  });

  it("confirm: конкурент забрав слот під час створення → SAVEPOINT, перечит, merge", async () => {
    const pending = await propose({ statement: "Живе в Одесі", slotKey: "confirm-race", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");
    const rival = competitorTakesSlot("confirm-race", "живе в одесі");

    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    // 23505 усередині confirm теж не долітає до колера: друга спроба бачить
    // голову конкурента й зливається з нею.
    expect(res).toEqual({ ok: true, claimId: rival });
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
  });

  it("два програші CAS → try_again, і кандидат лишається ВІДКРИТИМ у базі", async () => {
    await createClaim(
      { spaceId: SPACE_A, statement: "стара голова", slotKey: "city", origin: {}, reviewStatus: "confirmed" },
      ACTOR,
    );
    const pending = await propose({ statement: "нова голова", slotKey: "city", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    ctl.casLosses = 2;
    const res = await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(res).toEqual({ ok: false, reason: "try_again" });

    // resolved_at, який поставив CAS-крок 1, відкотився РАЗОМ із транзакцією —
    // інакше факт тихо зник би з черги перегляду.
    const cand = await candRow(pending.candidateId);
    expect(cand.resolved_at).toBeNull();
    expect(cand.claim_id).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.confirm'", [SPACE_A])).toBe(0);
  });

  it("confirm: чужий простір і неіснуючий id однаково дають not_found", async () => {
    const pending = await propose({ statement: "чужий факт", spaceId: SPACE_B, sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    expect(
      await confirmCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await confirmCandidate({ candidateId: `${P}немає`, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({
      ok: false,
      reason: "not_found",
    });
    // Чужий кандидат не зачеплений.
    expect((await candRow(pending.candidateId)).resolved_at).toBeNull();
  });

  it("reject: резолвить один раз, пише аудит, чужого не чіпає", async () => {
    const pending = await propose({ statement: "непотрібне", sensitive: true });
    if (pending.state !== "pending") throw new Error("expected pending");

    expect(await rejectCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({ ok: true });
    const cand = await candRow(pending.candidateId);
    expect(cand.resolved_at).not.toBeNull();
    expect(cand.claim_id).toBeNull();
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.reject'", [SPACE_A])).toBe(1);

    // Другий reject уже нічого не резолвить і другої події не пише.
    expect(await rejectCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({ ok: false });
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.reject'", [SPACE_A])).toBe(1);
    // Чужий простір — теж ні.
    expect(await rejectCandidate({ candidateId: pending.candidateId, allowedSpaceIds: [SPACE_B], actor: ACTOR })).toEqual({ ok: false });
  });

  it("listOpenCandidates: лише нерозв'язані й лише цього простору", async () => {
    const open = await propose({ statement: "чекає на людину", sensitive: true });
    if (open.state !== "pending") throw new Error("expected pending");
    const resolved = await propose({ statement: "уже вирішене", sensitive: true });
    if (resolved.state !== "pending") throw new Error("expected pending");
    await rejectCandidate({ candidateId: resolved.candidateId, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    await propose({ statement: "автоактивований" }); // resolved_at виставлено активацією
    await propose({ statement: "у чужому просторі", spaceId: SPACE_B, sensitive: true });

    const rows = await listOpenCandidates(SPACE_A);
    expect(rows.map((r) => r.id)).toEqual([open.candidateId]);
    expect(rows[0].statement).toBe("чекає на людину");

    expect((await listOpenCandidates(SPACE_B)).map((r) => r.statement)).toEqual(["у чужому просторі"]);
  });

  it("verifyDirectProvenance: цитата — так, вигадка — ні, парафраз на 60% — так", async () => {
    const turn = "Дедлайн проєкту переносять на наступний понеділок, попередь команду";

    // Дослівна цитата.
    expect(verifyDirectProvenance("Дедлайн проєкту переносять на наступний понеділок", turn)).toBe(true);
    // Регістр не має значення.
    expect(verifyDirectProvenance("ДЕДЛАЙН ПРОЄКТУ ПЕРЕНОСЯТЬ НА НАСТУПНИЙ ПОНЕДІЛОК", turn)).toBe(true);
    // Вигадка тула: користувач цього не писав.
    expect(verifyDirectProvenance("Користувач продав квартиру та переїхав до Барселони", turn)).toBe(false);
    // Парафраз рівно на межі: 3 з 5 довгих слів (дедлайн, проєкту, переносять) = 60% → так.
    expect(verifyDirectProvenance("Дедлайн проєкту переносять через оплату", turn)).toBe(true);
    // 2 з 5 (40%) — уже ні.
    expect(verifyDirectProvenance("Дедлайн команду зупинили через оплату", turn)).toBe(false);
    // Перевіряти нічого — довгих слів немає, тож і підтвердити авторство не можна.
    expect(verifyDirectProvenance("я тут", turn)).toBe(false);
  });
});
