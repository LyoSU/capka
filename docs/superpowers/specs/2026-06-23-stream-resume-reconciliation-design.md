# Відновлення стріму без обрізання — Snapshot + seq реконсиляція

**Дата:** 2026-06-23
**Статус:** дизайн затверджено, очікує на план реалізації

## Проблема

Користувач пише запит → асистент починає стрімити відповідь → користувач
виходить із чату (`ChatPanel` має `key={chatId}`, тож `useBackgroundChat`
розмонтовується, `EventSource` закривається) → повертається → бачить, що
стрімиться лише **нова** частина відповіді, а початок «обрізаний». Контент
самолікується аж на `task:finish` (повний `loadHistory`).

### Корінь (простежено наскрізь)

1. **SSE — чистий «живий» firehose без replay.** `src/app/api/events/route.ts`
   через Postgres `LISTEN/NOTIFY` пересилає лише події, опубліковані *після*
   підписки. При перепідключенні сервер нічого не дограває.
2. **Дельти інкрементальні.** `task:text-delta` несе тільки `delta`; клієнт у
   `use-background-chat.ts` робить `lastPart.text + data.delta` (дописує).
3. **Накопичений текст у БД зберігається лише на `finish-step`** (`runner.ts`).
   Для типової відповіді (один крок, суцільний текст) до `finish-step` у БД
   лежить `parts: []` (з insert при `task:start`).

**Разом:** при поверненні `loadHistory()` повертає асистентське повідомлення з
порожнім `parts`; SSE підхоплює дельти з поточної позиції моделі; вони
дописуються до порожнечі → видно лише хвіст.

Кодова база вже інтуїтивно визнає проблему: є шлях `_truncated → перечитати з БД`
і коментар у runner «persisted parts array is the source of truth, live drift
self-heals on the next save». Цей дизайн робить принцип системним.

## Принцип

Рядок у БД (`messages.metadata.parts`) — **єдине джерело істини** для контенту
асистента. SSE-дельти — жива оптимізація, ніколи не єдине джерело. Монотонний
`seq` на повідомлення дозволяє клієнту точно класифікувати кожну дельту: вже
покрита снапшотом / точно наступна / за нею «дірка».

## Архітектура змін

### 1. Realtime-контракт (`src/lib/tasks/events.ts`)

- Додати необов'язкове `seq?: number` до подій, прив'язаних до повідомлення:
  `task:start`, `task:text-delta`, `task:reasoning-delta`,
  `task:tool-input-start`, `task:tool-call`, `task:tool-result`, `task:finish`.
- Нова подія: `{ type: "task:reset"; taskId; chatId; messageId; seq }` — для
  retry-скидань усередині runner (коли `parts.length = 0`).

`seq` — необов'язкове, тож старі/інші публішери (Telegram-бот, `new_message`)
не зачіпаються; клієнт трактує відсутність `seq` як «не gate-ити» (застосувати
як раніше).

### 2. Снапшот-контракт (`src/lib/chat/contracts.ts` + `presenter.ts`)

- `MessageMeta.streamSeq?: number` — seq, до якого включно збережені `parts`.
- `presenter.ts` форвардить `metadata.streamSeq` у UI-метадані.
- **Міграція не потрібна** — `streamSeq` живе всередині JSONB `metadata`.

### 3. Сервер (`src/lib/tasks/runner.ts`)

- Лічильник `let seq = 0` на повідомлення. Хелпер `publish(event)` синхронно
  робить `seq += 1` і штампує його в кожну стрімінг-подію перед `await`
  публікації (порядок гарантує Postgres NOTIFY per-channel). `task:start`
  публікується з `seq = 0`; перша дельта → `seq = 1`. Insert повідомлення
  виставляє `metadata.streamSeq = 0`.
- **Прогресивний throttled-save `saveSnapshot()`**, частота **~1с**
  (максимум один UPDATE/сек на активний таск):
  - Викликається наприкінці `flushBuffers()` (де всі буферизовані дельти вже
    опубліковані й `parts` консистентний), але пропускається, якщо від
    минулого save минуло < ~1000мс.
  - **Синхронно** знімає `structuredClone(parts)`, поточний `seq`,
    `getFullText()`; *тоді* `await db.update(...)` пише `content`,
    `metadata.parts`, `status:"running"`, `metadata.streamSeq`. Синхронний
    знімок ⇒ `streamSeq` завжди точно відповідає записаним `parts`, навіть
    якщо токен дописався в `parts` під час `await` запису.
  - Існуючий `finish-step` save уніфікується через `saveSnapshot(force=true)`.
- Кожен retry-reset (`parts.length = 0` у `retryOnCapabilityError` та
  empty-response retry) публікує `task:reset` зі свіжим `seq` (через `publish`).

### 4. Клієнт (`src/hooks/use-background-chat.ts` + новий чистий модуль)

- **Новий чистий модуль** `src/lib/chat/stream-reconcile.ts` — редьюсер
  реконсиляції як чиста функція (поряд з `optimistic.ts`), легко юніт-тестувати
  без React/SSE. Сигнатура (орієнтовно):
  ```ts
  type ReconcileAction = "apply" | "ignore" | "reconcile" | "reset";
  function classifyEvent(appliedSeq: number, eventSeq: number | undefined):
    ReconcileAction;
  ```
  (Класифікація; саме застосування дельти до `parts` лишається у хуку, бо
  залежить від типу події.)
- `seqRef = useRef<Map<string, number>>()` — applied-seq на кожне стрімінг-
  повідомлення.
- `loadHistory`: підхоплюючи running-асистента (останнє повідомлення зі
  `status === "running"`), сідить `seqRef.set(id, metadata.streamSeq ?? 0)`.
- В `onmessage`, для подій із `seq` + `messageId`, gate перед застосуванням:
  - `seq <= applied` → **ignore** (вже в снапшоті / реплей).
  - `seq === applied + 1` → **apply** (наявний хендлер) + `seqRef.set(id, seq)`.
  - `seq > applied + 1` → **дірка** → `reconcileSoon()` (debounced `loadHistory`,
    guard `reconcilingRef` від тришингу); дельту не застосовуємо.
  - `task:reset` → очистити `parts` повідомлення, `seqRef.set(id, seq)`.
  - подія без `seq` → застосувати як раніше (зворотна сумісність).
- `task:finish` → повний `loadHistory` (лікує все) + чистка `seqRef` для
  повідомлення.

## Потік даних (відновлення посеред стріму)

1. Клієнт монтується, `loadHistory()` (fetch у польоті) + підписка на SSE.
2. Снапшот повертається зі `streamSeq = K` (збережений ≤1с тому, покриває
   `parts` до seq K). Клієнт показує **повний** текст дотепер,
   `seqRef[id] = K`.
3. Живі дельти з `seq > K` застосовуються по черзі — плавний хвіст.
4. Якщо між снапшотом і першою живою дельтою є розрив (дельти `K+1..K+n`
   надійшли поки повідомлення ще не було в стані) → перша наступна дельта дає
   `seq > applied+1` → `reconcileSoon()` підтягує свіжий снапшот (`streamSeq`
   уже більший) → `applied` стрибає вперед → живі дельти відновлюють потік.
   Збігається за ~1с; користувач завжди бачить цілісний, ніколи не обрізаний
   текст.

## Граничні випадки

- **Перепідключення посеред стріму:** основний сценарій — покрито (вище).
- **Втрата NOTIFY / `_truncated`:** існуючий reload-шлях + детекція дірки за
  `seq` обидва відновлюють.
- **Retry (capability/reasoning/empty):** `task:reset` очищає застарілий контент
  на клієнті; наступні дельти лягають на чисті `parts`.
- **Кілька вкладок:** кожна тримає власний `appliedSeq`, обидві збігаються
  незалежно.
- **Дедуп тулів за `toolCallId`:** лишається як defense-in-depth поверх seq.
- **Зворотна сумісність:** події без `seq` (Telegram, старі) застосовуються
  як раніше.

## Тестування

- **Unit** (`stream-reconcile.test.ts`): таблично `(applied, eventSeq)` → дія.
- **Integration** (розширити `src/lib/__tests__/realtime.integration.test.ts`):
  publish seq 1..N, відписати підписника посеред, перепідписати → фінальний
  контент == повний текст (без обрізання, без дублів).
- **Runner** (розширити `src/lib/__tests__/runner.e2e.test.ts`): `saveSnapshot`
  пише монотонний `streamSeq`, консистентний із записаними `parts`; `task:reset`
  публікується при retry.

## Поза обсягом (YAGNI)

- Окремий серверний буфер replay / `resumableStream` поверх Redis — не потрібен,
  бо БД-снапшот + seq закривають дірку без нової інфраструктури.
- Зміна формату дельт на абсолютні снапшоти — надлишково.
