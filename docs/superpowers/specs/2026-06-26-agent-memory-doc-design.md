# Памʼять агента як самопідтримуваний документ («CLAUDE.md у Postgres»)

**Дата:** 2026-06-26
**Статус:** дизайн затверджено, очікує на план реалізації

## Проблема

Поточна памʼять агента (`src/lib/memory/extract.ts`, таблиця `memories`) — це
**плоский ADD-only список рядків-фактів**:

- **Запис** — fire-and-forget після ходу: aux-LLM витягує «факти про КОРИСТУВАЧА»
  (один на рядок, <20 слів), дедуп через Jaccard/підрядок >0.7, `INSERT`.
  Наявні записи **ніколи не оновлюються й не зливаються** — лише додаються.
- **Читання** — `SELECT … ORDER BY createdAt DESC LIMIT 50`, усі 50 рядків
  **вивалюються гуртом** у `volatile`-суфікс системного промпта.
- **Тип** `{fact,preference,context}` мертвий: екстракція завжди пише `"fact"`,
  читання тип ігнорує.

### Наслідки

1. **«Агресивність» і дублі** — прямий симптом ADD-only: уточнювальні/суперечливі
   факти не зливаються, а накопичуються («любить dark mode» + пізніше «перейшов
   на light» співіснують). Необмежений ріст.
2. **Читання без релевантності** — 50 найновіших летять у некешований тир
   **щоходу**; коли рядків стане >50, старші тихо випадають за давністю (немає
   сигналу важливості).
3. **Лише «факти про юзера»** — знання про сам проєкт (як у цій кодовій базі:
   «рестартни контейнер після правки воркера») зберегти неможливо.
4. **Агент не курує памʼять** — усе пасивно; робочий агент не може свідомо
   «запамʼятай це» чи виправити хибний факт, хоча вже має тули (skills, MCP).

## Принцип

Памʼять — це **markdown-документ на scope**, що лежить у text-колонці Postgres.
Буквально `CLAUDE.md`, але байти в БД, а не на диску. Документ один і малий — він
просто **завжди в промпті цілком**, що розчиняє всю машинерію retrieval.

Документ — **mutable asset, що еволюціонує**, а не immutable log. Його чистоту
тримають **дві швидкості правок** (за Letta / sleeptime-консолідацією), щоб
уникнути semantic drift від сліпого перепису:

- **часто й дешево** — порядкові операції (дописати / точково замінити / видалити
  один рядок), мінімальний ризик втрати;
- **рідко й свідомо** — повна консолідація (`rethink`) під тригером розміру/лічби.

Сліпий повний перепис документа щоходу — **заборонений антипатерн** (irreversible
information loss → semantic drift накопичується).

## Архітектура змін

### 1. Сховище — таблиця `memory_docs` (`src/lib/db/schema.ts`)

```
memory_docs(
  id          text PK,
  userId      text NOT NULL → users(id) ON DELETE CASCADE,
  projectId   text NULLABLE → projects(id) ON DELETE CASCADE,
  content     text NOT NULL DEFAULT '',
  prevContent text,                      -- один крок назад: відкат поганої консолідації
  version     integer NOT NULL DEFAULT 0,
  turnsSinceConsolidation integer NOT NULL DEFAULT 0,
  updatedAt   timestamp DEFAULT now()
)
UNIQUE(userId, projectId)                -- один документ на scope
```

- `projectId IS NULL` = глобальний документ «про юзера» (≈ `~/CLAUDE.md`).
- `projectId = X` = документ проєкту X (≈ `project/CLAUDE.md`).
- Унікальний партіал-індекс на `(userId)` де `projectId IS NULL` (Postgres трактує
  NULL у UNIQUE як різні — потрібен окремий партіал-унік для глобального рядка).

Міграція drizzle генерується звичним workflow (`drizzle-kit generate`), комітиться
разом із кодом; boot-migrate застосовує. Див. практику schema-міграцій проєкту.

### 2. Читання — інжекція в промпт (`src/lib/chat/prompt.ts`, `runner.ts`)

- `runner.ts`: замість `SELECT … from(memories) LIMIT 50` — дві вибірки:
  глобальний документ (`projectId IS NULL`) і документ поточного проєкту
  (якщо `payload.projectId`). Обидва передаються в `buildSystemPrompt`.
- `buildSystemPrompt`: `memories: {content}[]` → `memoryDocs: { user?: string;
  project?: string }`. У `volatile`-суфікс:
  ```
  ## What you remember about the user:
  <user doc>

  ## What you remember about this project:
  <project doc>
  ```
  Лишається у `volatile` (некешований) — документ змінюється від ходу до ходу, тож
  кешувати в `session`-тирі не можна (бустнуло б кеш). Порожні документи опускаємо.

### 3. Запис — дві швидкості (`src/lib/memory/`)

Перейменувати/переписати `extract.ts`. Контракт оновлення документа:

**3a. Щоходу — `reconcileMemoryDoc(model, doc, turn, onUsage, hotContext?)`**

- aux-LLM отримує **поточний документ + хід** і повертає **список операцій**:
  `{ op: "add", text }` | `{ op: "replace", find, text }` | `{ op: "delete", find }`.
- Операції застосовуються детерміновано в коді (string-level), не моделлю — модель
  лише вирішує *що* робити. Append-зміщення: дефолт — `add`; `replace`/`delete`
  лише коли рядок справді застарів/суперечить.
- Зберігає cache-friendly hot-prefix шлях (як нинішній `buildAuxRequest`): на
  довгих чатах їде теплим префіксом, інструкція — трейлінг-юзер-тёрн.
- Документ оновлюється з optimistic `version`-check (див. §5). `turnsSinceConsolidation++`.
- Витрати — через `onUsage` на той самий key/budget, що й основний хід (як зараз).

**3b. Рідко — `consolidateMemoryDoc(model, doc)` (тригер у §3a)**

- Тригер: `content.length > MEMORY_DOC_MAX_BYTES` (≈2–3 КБ) **або**
  `turnsSinceConsolidation >= MEMORY_CONSOLIDATION_EVERY` (напр. 20).
- Повний `rethink`: модель отримує документ і повертає **реорганізований**
  (секції, злиті дублі, прибране застаріле, у межах ліміту).
- Перед записом: `prevContent = content` (відкат), `turnsSinceConsolidation = 0`,
  `version++`. Жорсткий клемп розміру після рештинку.

### 4. Агент тулом (`src/lib/memory/tool.ts`, реєстрація в `runner.ts`)

- `remember({ note, scope: "user" | "project" })` — навмисний `add` у відповідний
  документ (той самий безпечний append-шлях, що §3a). Свідомі нотатки причісує
  наступна консолідація.
- `forget({ match, scope })` — `delete`-операція за збігом рядка.
- Тули вантажаться поряд із наявними (skills/MCP/sandbox); scope `project` доступний
  лише коли хід має `projectId`.

### 5. Конкуренція

- Ходи в одному чаті серіалізовані наявним DB-інваріантом «один pending turn на чат».
- Два чати одного проєкту можуть писати в один документ → **optimistic concurrency**:
  `UPDATE … SET content=…, version=version+1 WHERE id=… AND version=:read`. Якщо
  0 рядків оновлено — перечитати документ і повторно застосувати операції (§3a
  ідемпотентний на рівні `add`/`replace`/`delete`). Консолідація на конфлікті —
  просто пропускається (наступний хід зробить).

### 6. UI (`src/app/(dashboard)/settings/memory/page.tsx`, `api/memories`)

- Сторінка стає **markdown-редактором на scope** (textarea: «Про мене» + перелік
  проєктних документів), а не списком рядків.
- `GET/PUT /api/memory-docs?projectId=` замість нинішніх `/api/memories` CRUD.
  Ручна правка юзером = звичайний `UPDATE` з `version++`.

### 7. Міграція даних

Одноразовий бекфіл у `.sql` міграції (або boot-скрипт): згрупувати наявні
`memories` по `(userId, projectId)`, зʼєднати `content` у bullets → seed
`memory_docs.content`. Опційно одна `consolidateMemoryDoc`-проходка лінивих
(перший раз при першому читанні). Таблицю `memories` ретайримо (drop у тій самій
або наступній міграції після підтвердження бекфілу).

## Константи (`src/lib/constants.ts`)

- `MEMORY_DOC_MAX_BYTES` ≈ 3000
- `MEMORY_CONSOLIDATION_EVERY` ≈ 20
- Прибрати `MEMORY_TYPES` (мертвий) після видалення `memories`.

## Тестування

- `reconcileMemoryDoc`: add нового факту; replace при суперечності; delete; no-op
  на порожньому виводі; дедуп проти наявного рядка (без накопичення).
- Застосування операцій (string-level) — детермінований юніт без LLM.
- `consolidateMemoryDoc`: тригер за розміром і за лічбою; `prevContent` виставляється;
  клемп розміру.
- Optimistic concurrency: симуляція конкурентного `version`-конфлікту → повтор.
- Прохід руками: правка документа в UI зберігається; агентський `remember` дописує;
  після N ходів документ лишається чистим і обмеженим.

## Поза обсягом (YAGNI)

- Векторна/графова памʼять, embeddings, семантичний retrieval.
- Ebbinghaus-decay як окремий джоб (консолідація дає забування «безкоштовно»).
- Історія версій глибша за один крок (`prevContent`); за потреби — окрема таблиця пізніше.
- Дворівневий індекс + recall-тул (непотрібні: документ малий і завжди в промпті).
