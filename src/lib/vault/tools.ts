import { tool } from "ai";
import { z } from "zod";
import { proposeCandidate, verifyDirectProvenance } from "./candidates";
import { findCurrentHead, forgetClaim, listHeadClaims, updateClaim, type ClaimHead } from "./claims";
import { getOrCreateSpace } from "./spaces";

/** Скільки рядків пам'яті віддаємо за один пошук. Пам'ять їде в контекст ходу,
 *  тож стеля тут — це стеля не «скільки цікаво», а «скільки не шкода». */
const SEARCH_LIMIT = 20;

/** Рядок для моделі: `[id@revision]` — це те, чим вона потім адресує клейм в
 *  update/forget, тож формат ідентичний у пошуку й у відповіді про успіх. */
const line = (c: ClaimHead) => `[${c.id}@${c.revision}] ${c.statement}${c.slotKey ? ` (slot: ${c.slotKey})` : ""}`;

/** Мова програшу CAS — одна на update і forget: розказати, як світ виглядає
 *  ЗАРАЗ, і чим переслати. `current: null` навмисно не розрізняє «ланцюг забуто»
 *  і «клейм не з твоїх просторів» — так вирішено в `claims.ts`, і тул не має
 *  права робити цю різницю спостережуваною. */
const mismatch = (current: ClaimHead | null) =>
  current
    ? `Claim ${current.id} is now at revision ${current.revision}: "${current.statement}". Re-issue with expected_revision=${current.revision} if the change still applies.`
    : "That claim no longer exists (it was forgotten).";

/** Довільне значення їде РЯДКОМ JSON, а не об'єктом: `asSchema` схлопує відкритий
 *  `z.record`/`z.unknown` у `additionalProperties: false`, і провайдер отримує
 *  схему, яку модель не може задовольнити.
 *
 *  Зламаний JSON — це РЕЗУЛЬТАТ тула, а не throw: throw обриває крок, а результат
 *  лишає моделі наступний крок, щоб переслати виправлене. */
function parseValueJson(raw: string | undefined): { ok: true; value: unknown } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return {
      ok: false,
      message: `value_json is not valid JSON: ${(e as Error).message}. Re-send with corrected JSON or omit it.`,
    };
  }
}

/** Що модель бачить замість `policy_state`. `denied` цією політикою не
 *  породжується (див. `proposeCandidate`), але таблиця лишається повною — інакше
 *  майбутнє правило governance тихо віддавало б `undefined`. `duplicate` — це
 *  переграний тул-колл (ретрай ходу), а не другий факт. */
const PROPOSE_SAID = {
  auto_active: "Saved.",
  merged: "Already known — added this conversation as evidence.",
  pending: "Saved as awaiting the user's confirmation.",
  conflict: "Conflicts with an existing fact — recorded for the user to resolve.",
  duplicate: "Already recorded from this same call.",
  denied: "Not saved — the memory policy declined this fact.",
} as const;

/**
 * Чотири тули пам'яті одного ходу. Фабрика асинхронна, бо простори резолвляться
 * один раз тут, а не в кожному `execute`: усі чотири тули розмежовані одним і
 * тим самим списком просторів, і резолвити його заново на кожен виклик означало
 * б чотири різні відповіді на одне питання «що мені видно».
 *
 * `userTurnText` — текст останнього user-повідомлення ходу. Порожній рядок —
 * це не помилка, а fail-safe: `verifyDirectProvenance` тоді поверне false, і
 * пропозиція ляже в pending замість активації.
 */
export async function makeVaultMemoryTools(ctx: {
  userId: string;
  projectId?: string | null;
  projectOwnerUserId?: string;
  messageId: string;
  userTurnText: string;
}) {
  // Власника project-простору знає колер (рядок проєкту вже в нього в руках).
  // Його відсутність — баг колера, а не привід вигадати власника чи мовчки
  // звалитись у user-простір: обидва варіанти записали б факт не туди.
  if (ctx.projectId && !ctx.projectOwnerUserId) {
    throw new Error("makeVaultMemoryTools: projectId requires projectOwnerUserId");
  }
  const userSpaceId = await getOrCreateSpace({ type: "user", refId: ctx.userId });
  const projectSpaceId =
    ctx.projectId && ctx.projectOwnerUserId
      ? await getOrCreateSpace({ type: "project", refId: ctx.projectId, ownerUserId: ctx.projectOwnerUserId })
      : null;
  const allowedSpaceIds = projectSpaceId ? [userSpaceId, projectSpaceId] : [userSpaceId];
  const actor = { kind: "agent" } as const;

  /** Клейми, які вже програли CAS у ЦЬОМУ ході. Живе в замиканні фабрики, а
   *  фабрику кличуть раз на хід — тож стан гасне разом із ходом за побудовою,
   *  без жодного прибирання. Тримає лише id: простір потрібен рівно там, де
   *  пишеться конфлікт, і зонд за ним живе там само. */
  const mismatched = new Set<string>();

  /** У якому просторі лежить клейм. `ClaimHead` не несе `spaceId` (текст клейма
   *  віддається лише тим, хто пройшов space-фільтр), тож єдиний спосіб — спитати
   *  вужчим скоупом. Викликається лише з конфліктної гілки: більшість програшів
   *  CAS другого не має, і платити за них SELECT-ом наперед нема за що. */
  const claimSpaceId = async (claimId: string) =>
    projectSpaceId && (await findCurrentHead(claimId, [projectSpaceId])) ? projectSpaceId : userSpaceId;

  return {
    memory_search: tool({
      description:
        "Search saved memory (facts about the user and this project). Returns claims as [id@revision] lines — use those ids for memory_update/memory_forget.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Words to look for; Ukrainian or English"),
        scope: z.enum(["user", "project", "all"]).optional().describe("Default: all"),
      }),
      execute: async ({ query, scope }) => {
        // Поза проєктом `scope: "project"` дає порожній список просторів — і це
        // чесніше, ніж тихо підмінити його user-простором: модель просила не те.
        const spaceIds =
          scope === "user"
            ? [userSpaceId]
            : scope === "project"
              ? projectSpaceId
                ? [projectSpaceId]
                : []
              : // Проєктний простір першим: у чаті проєкту він ближчий до справи, а
                // зшити два впорядкованих списки в один по-справжньому нічим —
                // `ClaimHead` не несе `recorded_at`.
                (projectSpaceId ? [projectSpaceId, userSpaceId] : [userSpaceId]);
        const needle = query.toLowerCase();
        const buckets: ClaimHead[][] = [];
        for (const spaceId of spaceIds) {
          // Еквівалент `ILIKE '%query%'` по statement АБО slot_key. Свідомо
          // примітивно: лексичний пошук — план C, і робити його тут наполовину
          // означало б два різні пошуки в одній системі.
          buckets.push(
            (await listHeadClaims(spaceId)).filter(
              (c) => c.statement.toLowerCase().includes(needle) || c.slotKey?.toLowerCase().includes(needle),
            ),
          );
        }
        // Стеля ділиться між просторами, а не з'їдається першим. Пошук — ЄДИНИЙ
        // спосіб дістати `[id@revision]`, тож двадцять збігів у проєкті інакше
        // робили б user-простір не лише невидимим, а й невиправним: ні update, ні
        // forget нема чим адресувати. Недобір одного простору доливає інший, тож
        // стеля використовується повністю.
        const quota = Math.ceil(SEARCH_LIMIT / Math.max(buckets.length, 1));
        const hits = buckets.flatMap((b) => b.slice(0, quota));
        for (const b of buckets) for (const c of b.slice(quota)) if (hits.length < SEARCH_LIMIT) hits.push(c);
        return hits.length ? hits.slice(0, SEARCH_LIMIT).map(line).join("\n") : "No saved memory matches.";
      },
    }),

    memory_propose: tool({
      description:
        "Save a new fact the user stated in this conversation. The server decides whether it becomes active immediately or awaits the user's confirmation.",
      inputSchema: z.object({
        statement: z.string().min(3).max(500),
        scope: z
          .enum(["user", "project"])
          .optional()
          .describe(
            "Where to store: 'user' = about the person (follows them everywhere), 'project' = about this project. Default: project when inside a project, else user.",
          ),
        slot_key: z
          .string()
          .max(120)
          .optional()
          .describe("Optional stable key like 'постачальник/акме/відстрочка' for facts that change over time"),
        value_json: z.string().max(2000).optional().describe("Optional structured value as a JSON string"),
        sensitive: z.boolean().optional().describe("Set true for health/politics/religion/private-life facts"),
      }),
      execute: async ({ statement, scope, slot_key, value_json, sensitive }, { toolCallId }) => {
        const parsed = parseValueJson(value_json);
        if (!parsed.ok) return parsed.message;
        // `scope: "project"` поза проєктом падає в user-простір: факт уже
        // сказаний, і втратити його гірше, ніж покласти на рівень вище.
        const wantsProject = (scope ?? (projectSpaceId ? "project" : "user")) === "project";
        const spaceId = wantsProject && projectSpaceId ? projectSpaceId : userSpaceId;
        const res = await proposeCandidate({
          idempotencyKey: `${ctx.messageId}:${toolCallId}`,
          spaceId,
          originMessageId: ctx.messageId,
          statement,
          slotKey: slot_key,
          value: parsed.value,
          // Бар'єр проти ін'єкції: «користувач сказав це сам» — не слова тула, а
          // перевірка проти тексту його ходу. Не збіглося — `derived`, і політика
          // відправить факт на підтвердження замість автоактивації.
          provenance: {
            kind: verifyDirectProvenance(statement, ctx.userTurnText) ? "user_direct" : "derived",
            messageId: ctx.messageId,
          },
          sensitive,
          // Без цього відповідь «додав цю розмову як доказ» була б неправдою:
          // саме ці докази `proposeCandidate` доливає до голови на merge.
          evidence: [{ messageId: ctx.messageId }],
        });
        return PROPOSE_SAID[res.state];
      },
    }),

    memory_update: tool({
      description:
        "Correct or refine an existing memory claim. Requires the claim id and revision from memory_search. At least one of statement/value_json must be provided.",
      inputSchema: z
        .object({
          claim_id: z.string(),
          expected_revision: z.number().int().min(1),
          statement: z.string().min(3).max(500).optional(),
          value_json: z.string().max(2000).optional(),
        })
        // Валідує на сервері, але в JSON Schema НЕ потрапляє — саме тому та сама
        // вимога дослівно стоїть у `description`, інакше модель про неї не дізнається.
        .refine((v) => v.statement !== undefined || v.value_json !== undefined, {
          message: "provide statement or value_json",
        }),
      execute: async ({ claim_id, expected_revision, statement, value_json }, { toolCallId }) => {
        const parsed = parseValueJson(value_json);
        if (!parsed.ok) return parsed.message;
        const patch: { statement?: string; value?: unknown } = {};
        if (statement !== undefined) patch.statement = statement;
        if (value_json !== undefined) patch.value = parsed.value;

        const res = await updateClaim({
          claimId: claim_id,
          expectedRevision: expected_revision,
          patch,
          allowedSpaceIds,
          actor,
        });
        // Supersede створює НОВИЙ рядок, тож id клейма змінився: без нього
        // наступний update моделі йшов би за мертвою адресою.
        if (res.ok) return `Updated. The claim is now [${res.id}@${res.revision}].`;

        // Клейма немає (ланцюг забуто АБО він не з наших просторів) — і другий
        // програш цього не змінює. Конфлікт тут був би суперечкою з порожнечею:
        // людині показали б «розв'яжіть» проти факту, якого нема, а текст моделі
        // заїхав би у сховище за неіснуючим id.
        if (!res.current) return mismatch(null);
        if (!mismatched.has(claim_id)) {
          mismatched.add(claim_id);
          return mismatch(res.current);
        }
        // Другий програш поспіль по тому ж клейму — це вже не «перечитай», а
        // розбіжність, яку розв'язує людина. Але фіксувати нема чого, якщо нового
        // ТЕКСТУ немає: кандидат — це твердження, яке хтось читатиме, і підставити
        // туди старе формулювання означало б записати конфлікт сам із собою.
        if (statement === undefined) return mismatch(res.current);
        await proposeCandidate({
          idempotencyKey: `${ctx.messageId}:${toolCallId}:conflict`,
          spaceId: await claimSpaceId(claim_id),
          originMessageId: ctx.messageId,
          statement,
          // Не `user_direct` навіть за дослівного збігу: активувати текст, який
          // ЩОЙНО програв CAS, означало б обійти голову замість розв'язати конфлікт.
          provenance: { kind: "derived", messageId: ctx.messageId },
          // Чутливість — властивість ФАКТУ, а не рішення політики: `forceState`
          // однаково веде в conflict, тож не передати її означало б просто
          // загубити прапорець на рядку, який читатиме людина (і все, що по ньому
          // ховає текст).
          sensitive: res.current.sensitive,
          evidence: [{ messageId: ctx.messageId }],
          forceState: "conflict",
        });
        return "Recorded as a conflict for the user to resolve.";
      },
    }),

    memory_forget: tool({
      description:
        "Forget a memory claim the user asked to remove. Requires id and revision from memory_search.",
      inputSchema: z.object({
        claim_id: z.string(),
        expected_revision: z.number().int().min(1),
        reason: z.string().max(300).optional(),
      }),
      execute: async ({ claim_id, expected_revision, reason }) => {
        const res = await forgetClaim({
          claimId: claim_id,
          expectedRevision: expected_revision,
          allowedSpaceIds,
          actor,
          reason,
        });
        return res.ok ? "Forgotten." : mismatch(res.current);
      },
    }),
  };
}
