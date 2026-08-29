import { describe, it, expect, vi, beforeEach } from "vitest";
import { asSchema } from "ai";

// Сервіси мокані навмисно: у кожного з них є власний інтеграційний suite проти
// живої БД, а тут перевіряється рівно те, що є тільки в цьому модулі — з ЯКИМИ
// аргументами тули їх кличуть і що модель бачить у відповідь.
const { getOrCreateSpace, listHeadClaims, updateClaim, forgetClaim, findCurrentHead, proposeCandidate, verifyDirectProvenance } =
  vi.hoisted(() => ({
    getOrCreateSpace: vi.fn(),
    listHeadClaims: vi.fn(),
    updateClaim: vi.fn(),
    forgetClaim: vi.fn(),
    findCurrentHead: vi.fn(),
    proposeCandidate: vi.fn(),
    verifyDirectProvenance: vi.fn(),
  }));
vi.mock("../spaces", () => ({ getOrCreateSpace }));
vi.mock("../claims", () => ({ listHeadClaims, updateClaim, forgetClaim, findCurrentHead }));
vi.mock("../candidates", () => ({ proposeCandidate, verifyDirectProvenance }));

import { makeVaultMemoryTools } from "../tools";

const USER_SPACE = "space-user";
const PROJECT_SPACE = "space-project";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opts = (toolCallId: string) => ({ toolCallId, messages: [] }) as any;

const head = (
  over: Partial<{ id: string; revision: number; statement: string; slotKey: string | null; sensitive: boolean }> = {},
) => ({
  id: "c1",
  revision: 1,
  statement: "Клієнт платить у гривні",
  slotKey: null,
  value: null,
  reviewStatus: "confirmed",
  sensitive: false,
  ...over,
});

const make = (over: Partial<Parameters<typeof makeVaultMemoryTools>[0]> = {}) =>
  makeVaultMemoryTools({
    userId: "u1",
    projectId: "p1",
    projectOwnerUserId: "u1",
    messageId: "m1",
    userTurnText: "Клієнт платить у гривні, запам'ятай",
    ...over,
  });

type Tools = Awaited<ReturnType<typeof makeVaultMemoryTools>>;
const run = async (tool: Tools[keyof Tools], args: unknown, toolCallId = "call-1"): Promise<string> =>
  (await tool.execute!(args as never, opts(toolCallId))) as string;

beforeEach(() => {
  vi.resetAllMocks();
  getOrCreateSpace.mockImplementation(async (scope: { type: string }) =>
    scope.type === "project" ? PROJECT_SPACE : USER_SPACE,
  );
  verifyDirectProvenance.mockReturnValue(true);
  listHeadClaims.mockResolvedValue([]);
  proposeCandidate.mockResolvedValue({ state: "auto_active", claimId: "c9", revision: 1 });
});

describe("makeVaultMemoryTools — фабрика", () => {
  it("віддає рівно чотири тули", async () => {
    expect(Object.keys(await make()).sort()).toEqual([
      "memory_forget",
      "memory_propose",
      "memory_search",
      "memory_update",
    ]);
  });

  it("падає ясно, коли projectId є, а власника проєкту не передали", async () => {
    await expect(make({ projectOwnerUserId: undefined })).rejects.toThrow(/projectOwnerUserId/);
  });
});

describe("memory_propose", () => {
  it("бере project-простір у проєкті, кладе user_direct і ключ messageId:toolCallId", async () => {
    const tools = await make();
    expect(await run(tools.memory_propose, { statement: "Клієнт платить у гривні" }, "call-7")).toBe("Saved.");

    expect(verifyDirectProvenance).toHaveBeenCalledWith("Клієнт платить у гривні", "Клієнт платить у гривні, запам'ятай");
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "m1:call-7",
        spaceId: PROJECT_SPACE,
        originMessageId: "m1",
        statement: "Клієнт платить у гривні",
        provenance: { kind: "user_direct", messageId: "m1" },
        // Повідомлення «додав цю розмову як доказ» бреше без цього.
        evidence: [{ messageId: "m1" }],
      }),
    );
  });

  it("поза проєктом дефолт — user-простір, а невідповідність ходу дає derived", async () => {
    verifyDirectProvenance.mockReturnValue(false);
    proposeCandidate.mockResolvedValue({ state: "pending", candidateId: "cand1" });
    const tools = await make({ projectId: null, projectOwnerUserId: undefined });

    expect(await run(tools.memory_propose, { statement: "Улюблений колір — синій" })).toBe(
      "Saved as awaiting the user's confirmation.",
    );
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: USER_SPACE, provenance: { kind: "derived", messageId: "m1" } }),
    );
  });

  it("явний scope перекриває дефолт", async () => {
    const tools = await make();
    await run(tools.memory_propose, { statement: "Живе у Львові", scope: "user" });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
  });

  it("поза проєктом scope:'project' падає в user-простір, а не втрачає факт", async () => {
    // Асиметрія з memory_search свідома: факт уже сказаний, і покласти його
    // рівнем вище дешевше, ніж загубити; пошук же нічого не втрачає, мовчки
    // підмінивши простір, тому там — порожньо.
    const tools = await make({ projectId: null, projectOwnerUserId: undefined });
    await run(tools.memory_propose, { statement: "Дедлайн у п'ятницю", scope: "project" });
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
  });

  it("зламаний value_json — це РЕЗУЛЬТАТ тула, не throw, і пропозиції не було", async () => {
    const tools = await make();
    const out = await run(tools.memory_propose, { statement: "Відстрочка 30 днів", value_json: "{нема" });
    expect(out).toMatch(/^value_json is not valid JSON: /);
    expect(out).toContain("Re-send with corrected JSON or omit it.");
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("валідний value_json їде розібраним значенням разом зі слотом і чутливістю", async () => {
    const tools = await make();
    await run(tools.memory_propose, {
      statement: "Відстрочка 30 днів",
      slot_key: "постачальник/акме/відстрочка",
      value_json: '{"days":30}',
      sensitive: true,
    });
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ value: { days: 30 }, slotKey: "постачальник/акме/відстрочка", sensitive: true }),
    );
  });

  it("переказує рішення політики словами, а не станом", async () => {
    const tools = await make();
    proposeCandidate.mockResolvedValue({ state: "merged", claimId: "c2" });
    expect(await run(tools.memory_propose, { statement: "Клієнт платить у гривні" })).toBe(
      "Already known — added this conversation as evidence.",
    );
    proposeCandidate.mockResolvedValue({ state: "conflict", candidateId: "cand2" });
    expect(await run(tools.memory_propose, { statement: "Клієнт платить у доларах" })).toBe(
      "Conflicts with an existing fact — recorded for the user to resolve.",
    );
  });
});

describe("memory_update", () => {
  it("успіх повертає НОВИЙ id і ревізію — supersede міняє id", async () => {
    updateClaim.mockResolvedValue({ ok: true, id: "c2", revision: 2 });
    const tools = await make();
    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "Тепер у доларах" });

    expect(out).toContain("[c2@2]");
    expect(updateClaim).toHaveBeenCalledWith({
      claimId: "c1",
      expectedRevision: 1,
      patch: { statement: "Тепер у доларах" },
      allowedSpaceIds: [USER_SPACE, PROJECT_SPACE],
      actor: { kind: "agent" },
    });
  });

  it("перший mismatch — інструктивний текст із поточною ревізією, без кандидата", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4, statement: "У євро" }) });
    findCurrentHead.mockResolvedValue(null);
    const tools = await make();

    expect(await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "У доларах" })).toBe(
      'Claim c5 is now at revision 4: "У євро". Re-issue with expected_revision=4 if the change still applies.',
    );
    expect(proposeCandidate).not.toHaveBeenCalled();
    // Простір потрібен лише конфлікту, а більшість програшів CAS другого не має.
    expect(findCurrentHead).not.toHaveBeenCalled();
  });

  it("забутий клейм не витікає нічим, крім «його немає»", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: null });
    findCurrentHead.mockResolvedValue(null);
    const tools = await make();
    expect(await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "У доларах" })).toBe(
      "That claim no longer exists (it was forgotten).",
    );
  });

  it("ДРУГИЙ mismatch по тому ж клейму фіксує конфлікт у просторі клейма, зберігаючи чутливість", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4, sensitive: true }) });
    // Клейм знайшовся у project-просторі → саме туди й лягає конфлікт.
    findCurrentHead.mockResolvedValue(head({ id: "c5", revision: 4 }));
    proposeCandidate.mockResolvedValue({ state: "conflict", candidateId: "cand3" });
    const tools = await make();

    await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, statement: "У доларах" }, "call-1");
    expect(proposeCandidate).not.toHaveBeenCalled();

    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 4, statement: "У доларах" }, "call-2");
    expect(out).toBe("Recorded as a conflict for the user to resolve.");
    expect(findCurrentHead).toHaveBeenCalledWith("c1", [PROJECT_SPACE]);
    expect(proposeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        forceState: "conflict",
        idempotencyKey: "m1:call-2:conflict",
        spaceId: PROJECT_SPACE,
        statement: "У доларах",
        provenance: { kind: "derived", messageId: "m1" },
        // Чутливість — властивість факту; conflict-гейт її не заміняє.
        sensitive: true,
        evidence: [{ messageId: "m1" }],
      }),
    );
  });

  it("клейм не з project-простору → конфлікт лягає в user-простір", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4 }) });
    findCurrentHead.mockResolvedValue(null);
    proposeCandidate.mockResolvedValue({ state: "conflict", candidateId: "cand4" });
    const tools = await make();

    await run(tools.memory_update, { claim_id: "cX", expected_revision: 1, statement: "У доларах" }, "call-1");
    await run(tools.memory_update, { claim_id: "cX", expected_revision: 1, statement: "У доларах" }, "call-2");
    expect(proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({ spaceId: USER_SPACE }));
  });

  it("другий mismatch по НЕІСНУЮЧОМУ клеймі не вигадує конфлікт ні з чим", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: null });
    const tools = await make();

    for (const call of ["call-1", "call-2", "call-3"]) {
      expect(await run(tools.memory_update, { claim_id: "cX", expected_revision: 1, statement: "У доларах" }, call)).toBe(
        "That claim no longer exists (it was forgotten).",
      );
    }
    expect(proposeCandidate).not.toHaveBeenCalled();
    expect(findCurrentHead).not.toHaveBeenCalled();
  });

  it("дзеркало mismatch-ів живе рівно один хід", async () => {
    updateClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 4 }) });
    findCurrentHead.mockResolvedValue(null);
    const first = await make();
    await run(first.memory_update, { claim_id: "c1", expected_revision: 1, statement: "У доларах" });
    // Наступний хід — нова фабрика, тож це знову ПЕРШИЙ mismatch.
    const second = await make();
    const out = await run(second.memory_update, { claim_id: "c1", expected_revision: 1, statement: "У доларах" });
    expect(out).toContain("Re-issue with expected_revision=4");
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it("зламаний value_json не доходить до сервісу", async () => {
    const tools = await make();
    const out = await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, value_json: "[1,]" });
    expect(out).toMatch(/^value_json is not valid JSON: /);
    expect(updateClaim).not.toHaveBeenCalled();
  });

  it("value_json їде в патч розібраним", async () => {
    updateClaim.mockResolvedValue({ ok: true, id: "c2", revision: 2 });
    const tools = await make();
    await run(tools.memory_update, { claim_id: "c1", expected_revision: 1, value_json: '{"days":45}' });
    expect(updateClaim).toHaveBeenCalledWith(expect.objectContaining({ patch: { value: { days: 45 } } }));
  });
});

describe("memory_forget", () => {
  it("забуває й підтверджує це", async () => {
    forgetClaim.mockResolvedValue({ ok: true });
    const tools = await make();
    expect(await run(tools.memory_forget, { claim_id: "c1", expected_revision: 1, reason: "застаріло" })).toBe(
      "Forgotten.",
    );
    expect(forgetClaim).toHaveBeenCalledWith({
      claimId: "c1",
      expectedRevision: 1,
      allowedSpaceIds: [USER_SPACE, PROJECT_SPACE],
      actor: { kind: "agent" },
      reason: "застаріло",
    });
  });

  it("чужий клейм читається як неіснуючий і нічого про себе не каже", async () => {
    forgetClaim.mockResolvedValue({ ok: false, current: null });
    const tools = await make();
    expect(await run(tools.memory_forget, { claim_id: "чужий", expected_revision: 1 })).toBe(
      "That claim no longer exists (it was forgotten).",
    );
  });

  it("mismatch-мова та сама, що в update", async () => {
    forgetClaim.mockResolvedValue({ ok: false, current: head({ id: "c5", revision: 3, statement: "У євро" }) });
    const tools = await make();
    expect(await run(tools.memory_forget, { claim_id: "c1", expected_revision: 1 })).toBe(
      'Claim c5 is now at revision 3: "У євро". Re-issue with expected_revision=3 if the change still applies.',
    );
  });
});

describe("memory_search", () => {
  it("шукає підрядок у statement АБО slot_key і форматує рядки з id@revision", async () => {
    listHeadClaims.mockImplementation(async (spaceId: string) =>
      spaceId === PROJECT_SPACE
        ? [
            head({ id: "c1", revision: 2, statement: "Клієнт платить у Гривні" }),
            head({ id: "c2", revision: 1, statement: "Нічого спільного", slotKey: "гривня/курс" }),
            head({ id: "c3", revision: 1, statement: "Зовсім інше" }),
          ]
        : [],
    );
    const tools = await make();
    const out = await run(tools.memory_search, { query: "гривн" });
    expect(out).toBe("[c1@2] Клієнт платить у Гривні\n[c2@1] Нічого спільного (slot: гривня/курс)");
  });

  it("порожній результат — це речення, а не порожній рядок", async () => {
    const tools = await make();
    expect(await run(tools.memory_search, { query: "нічого" })).toBe("No saved memory matches.");
  });

  it("scope звужує простори; дефолт бере обидва", async () => {
    listHeadClaims.mockResolvedValue([]);
    const tools = await make();
    await run(tools.memory_search, { query: "х" });
    expect(listHeadClaims.mock.calls.map((c) => c[0])).toEqual([PROJECT_SPACE, USER_SPACE]);

    listHeadClaims.mockClear();
    await run(tools.memory_search, { query: "х", scope: "user" });
    expect(listHeadClaims.mock.calls.map((c) => c[0])).toEqual([USER_SPACE]);
  });

  it("віддає не більше 20 рядків", async () => {
    listHeadClaims.mockImplementation(async (spaceId: string) =>
      spaceId === PROJECT_SPACE
        ? Array.from({ length: 30 }, (_, i) => head({ id: `c${i}`, statement: `факт ${i}` }))
        : [],
    );
    const tools = await make();
    expect((await run(tools.memory_search, { query: "факт" })).split("\n")).toHaveLength(20);
  });

  it("переповнений проєкт не витісняє user-простір зі списку", async () => {
    // Без поділу стелі двадцять проєктних збігів зробили б user-клейми не лише
    // невидимими, а й невиправними: id для update/forget беруться тільки звідси.
    listHeadClaims.mockImplementation(async (spaceId: string) =>
      Array.from({ length: 30 }, (_, i) =>
        head({ id: `${spaceId === PROJECT_SPACE ? "p" : "u"}${i}`, statement: `факт ${i}` }),
      ),
    );
    const tools = await make();
    const lines = (await run(tools.memory_search, { query: "факт" })).split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.filter((l) => l.startsWith("[p"))).toHaveLength(10);
    expect(lines.filter((l) => l.startsWith("[u"))).toHaveLength(10);
  });

  it("поза проєктом scope:'project' не підмінює простір, а віддає порожньо", async () => {
    const tools = await make({ projectId: null, projectOwnerUserId: undefined });
    expect(await run(tools.memory_search, { query: "х", scope: "project" })).toBe("No saved memory matches.");
    expect(listHeadClaims).not.toHaveBeenCalled();
  });
});

// Тул із відкритим об'єктом у схемі модель заповнити НЕ МОЖЕ: `asSchema` схлопує
// `z.record`/`z.unknown` у `additionalProperties: false`, і провайдер отримує
// схему, яку неможливо задовольнити (той самий баг, що ловить тест `manage`).
// Тому довільне значення їде рядком `value_json`, а це — сторожовий дріт на те,
// що ніхто не «покращив» схему назад до об'єкта.
describe("схеми, які реально бачить провайдер", () => {
  const jsonSchemas = async () => {
    const tools = await make();
    return Object.entries(tools).map(([name, t]) => [name, asSchema(t.inputSchema as never).jsonSchema] as const);
  };

  it("жодне поле не є об'єктом і не несе additionalProperties/propertyNames", async () => {
    for (const [name, js] of await jsonSchemas()) {
      const props = (js as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
      expect(Object.keys(props).length, name).toBeGreaterThan(0);
      for (const [field, spec] of Object.entries(props)) {
        expect(spec.type, `${name}.${field}`).not.toBe("object");
        expect(spec.additionalProperties, `${name}.${field}`).toBeUndefined();
        expect(spec.propertyNames, `${name}.${field}`).toBeUndefined();
      }
    }
  });

  it("`.refine` НЕ доїжджає в JSON Schema, тому вимога живе ще й у description", async () => {
    const tools = await make();
    const js = asSchema(tools.memory_update.inputSchema).jsonSchema as { required?: string[] };
    // Якби refine серіалізувався, тут була б хоч якась згадка про statement/value_json.
    expect(js.required).toEqual(["claim_id", "expected_revision"]);
    expect(tools.memory_update.description).toContain(
      "At least one of statement/value_json must be provided.",
    );
  });

  it("refine усе ж валідує на боці сервера", async () => {
    const tools = await make();
    const parsed = (tools.memory_update.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      claim_id: "c1",
      expected_revision: 1,
    });
    expect(parsed.success).toBe(false);
  });
});
