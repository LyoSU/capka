# Дизайн: ізольований компьют-шар sandbox-контролера

**Дата:** 2026-06-21
**Статус:** затверджено до планування
**Автор:** обговорення LyoSU + Claude

---

## 1. Контекст і проблема

Платформа виконує згенерований AI код у sandbox-контейнерах. Сьогодні `sandbox-controller`
напряму викликає `dockerode` поверх `socket-proxy`, тримає стан сесій **у пам'яті** (`Map`),
а workspace монтує bind'ом із локального диска хоста (`detectHostDataRoot`/`toHostPath`).

Це породило конкретний прод-інцидент: образ `unclaw-sandbox:latest` зник із хоста (ймовірно —
автоматичне Docker-очищення Coolify видалило «невикористовуваний» образ, бо одноразовий
складальник вийшов і жоден постійний контейнер його не тримав). Наслідок — кожен
`POST /sessions` падає з `404 No such image`, чати не працюють.

Інцидент — **симптом**, не корінь. Корені:

1. **Життєвий цикл образу поза контролем споживача.** Контролер не гарантує наявність рантайму
   перед створенням; `socket-proxy` навіть не дозволяє pull.
2. **Стан у пам'яті.** Рестарт губить `networkMode`, обнуляє `lastActivity`; неможливо тримати
   більше одного інстансу.
3. **Прив'язка до локального диска.** Bind-монти з трансляцією host-path крихкі між
   Docker Desktop / native Linux / Coolify і не масштабуються на кілька нод.
4. **Ізоляція.** Контролер root-equivalent на хості; `socket-proxy` — defense-in-depth, не межа;
   голі контейнери (`runc`) ділять ядро хоста.

### Модель загроз (визначальна)

**Мультитенантно, untrusted.** Різні компанії/люди на одному деплої, AI виконує довільний код.
Container escape = компрометація хоста, усіх тенантів і спільного адмін-ключа. Голих контейнерів
**недостатньо** — потрібна сильна ізоляція.

---

## 2. Позиціонування (навмисний диференціатор)

**Самохостована сильна ізоляція «з коробки», без обов'язкового платного хмарного sandbox.**

У Daytona/E2B керована хмара по суті обов'язкова й дорога; Daytona навіть за замовчуванням
використовує звичайний Docker, а сильнішу ізоляцію вмикає опційно. unClaw дає сильну ізоляцію
**за замовчуванням** і **на власному VPS** — через gVisor, який не потребує KVM і ставиться
майже будь-де. Хмарний/microVM-шлях лишається опцією, не вимогою.

---

## 3. Цілі та не-цілі

### Цілі
- Єдиний внутрішній інтерфейс компьюта (`ComputeBackend`), за яким платформа й ядро контролера
  не міняються при зміні топології.
- Сильна ізоляція untrusted-коду **за замовчуванням** на self-host (Docker + gVisor + hardening),
  fail-closed.
- Усунути prune-баг структурно (`ensureRuntime()` як передумова `create()`).
- Durable-стан сесій (Postgres) → stateless-контролер, що переживає рестарт.
- HTTP-контракт платформа↔контролер **не міняється**.

### Не-цілі (свідомо поза цим етапом, за YAGNI)
- `WorkspaceStore`/`ObjectStore` — лишаємо локальний bind; абстракцію файлів додамо, коли
  з'явиться реальна багатонодовість.
- `KubernetesBackend`, реалізація `ManagedBackend` — лишаємо port-ready, не кодуємо зараз.
- Тенант-скоупінг спільного адмін-ключа — ортогональна діра платформного рівня; окремий follow-up.
- Firecracker-snapshotting / instant-fork — майбутня оптимізація.

---

## 4. Архітектура

Hexagonal (Ports & Adapters) **всередині наявного контролера**. Контролер лишається єдиним
мережевим швом; усе змінне ізольоване в **один порт**.

```
platform ──HTTP (контракт незмінний)──▶  CONTROLLER CORE
                                          HTTP API · auth/HMAC · quotas ·
                                          idle-cleanup · eviction · recovery ·
                                          SessionStore(Postgres)
                                                   │
                                          ComputeBackend  ← єдиний порт
                          ┌────────────────────────┼───────────────────────┐
                    DockerBackend              (Kata/Firecracker        ManagedBackend
                    + gVisor (runsc)            через Runtime,          (E2B/Fly) — port-ready,
                    + hardening-профіль         opt-in де є KVM)        не реалізуємо зараз
                    ← ДЕФОЛТ
```

Принцип мінімального коду: **усе спільне пишеться раз** і живе над портом; кожен майбутній
бекенд — це один файл, ядро не чіпається.

---

## 5. Порт `ComputeBackend`

```ts
interface SandboxSpec {
  sessionId: string;
  userId: string;
  wsHostPath: string;       // звідки взяти workspace (поки локальний шлях)
  sharedHostPath: string;
  networkMode: "none" | "bridge";
  memoryBytes: number;
  nanoCpus: number;
}

interface ExecResult { stdout: string; stderr: string; exitCode: number; }

interface RecoveredSandbox { sessionId: string; userId: string; handle: string; running: boolean; }

interface ComputeBackend {
  /** Гарантувати наявність рантайму/образу ПЕРЕД create. Ідемпотентно, з дедупом
   *  одночасних викликів. Docker: pull-if-missing. K8s: noop. Managed: noop. */
  ensureRuntime(): Promise<void>;

  /** Підняти sandbox, прив'язаний до workspace. Повертає opaque-handle
   *  (containerId | podName | machineId). */
  create(spec: SandboxSpec): Promise<{ handle: string }>;

  /** Виконати команду в sandbox із таймаутом (kill всієї process-group). */
  exec(handle: string, command: string, timeoutMs: number): Promise<ExecResult>;

  /** Зупинити й прибрати sandbox (workspace НЕ чіпається — переживає контейнер). */
  destroy(handle: string): Promise<void>;

  /** Перелік наявних sandbox'ів для recovery/reconcile (за лейблами/селекторами). */
  list(): Promise<RecoveredSandbox[]>;
}
```

Вибір реалізації — через env `COMPUTE_BACKEND=docker` (поки лише `docker`).

---

## 6. Ядро контролера (спільне, ~90% коду)

Лишається над портом, **не дублюється** в бекендах і логічно переноситься майже дослівно з
теперішнього `server.js`:

- HTTP-роутинг та API (`/sessions`, `/exec`, `/files`, `/download`, `/upload`, `/health`) — контракт незмінний.
- Авторизація: `safeEqual` bearer + HMAC `workspaceToken` для файлових операцій без живого контейнера.
- Квоти: `MAX_SESSIONS_PER_USER`, `MAX_WORKSPACE_MB`, `MAX_UPLOAD_MB`.
- Eviction least-recently-used при перевищенні per-user ліміту.
- Idle-cleanup за `IDLE_TTL`.
- Recovery/reconcile при старті.
- Файлові операції (поки) — нативний fs над локальним workspace (як зараз).

---

## 7. Ізоляція (суть етапу)

### Дефолт: Docker + gVisor (`runsc`)
- `HostConfig.Runtime = "runsc"` у конфізі контейнера (один прапор у `buildSandboxConfig`).
- gVisor — userspace-ядро з перехопленням syscall'ів; **не потребує KVM** → ставиться на
  звичайний VPS. Це production-планка мультитенантної ізоляції (Google Cloud Run / GKE Sandbox).

### Hardening-профіль (на кожен sandbox)
- `CapDrop: ["ALL"]`
- `SecurityOpt: ["no-new-privileges"]`
- read-only rootfs + `tmpfs` на `/tmp`
- `PidsLimit`
- mem/cpu ліміти (вже є)
- мережа `none` за замовчуванням (вже є; bridge — opt-in)
- userns-remap на рівні демона (документуємо як host-prereq)

### Fail-closed
Якщо налаштовано `SANDBOX_RUNTIME=runsc`, а `runsc` на хості недоступний — контролер
**відмовляється стартувати** (за зразком перевірки `CONTROLLER_SECRET`), а не падає тихо на
небезпечний `runc`. Окремий явний `SANDBOX_RUNTIME=runc` (`dev/trusted`-режим) дозволяє голі
контейнери з гучним попередженням.

### Опційні рівні (port-ready, не реалізуємо зараз)
- **Kata/Firecracker** (`Runtime="kata"`) — HW-межа, той самий `DockerBackend`, лише де є KVM.
- **Managed** (E2B/Fly) — окремий бекенд за тим самим портом, для zero-ops.

### Host-prereq
gVisor потребує встановленого `runsc` + конфігу демона. Додаємо `scripts/install-gvisor.sh` і
документацію; healthcheck/boot-перевірка підтверджує доступність рантайму (fail-closed вище).

---

## 8. Життєвий цикл образу (фікс prune-бага)

`DockerBackend.ensureRuntime()`:
1. `docker.getImage(SANDBOX_IMAGE).inspect()` — якщо є, готово (кешований прапор «ensured»).
2. Якщо `404` — `docker.pull()` з ghcr, дочекатись `followProgress` до кінця.
3. Дедуп одночасних викликів (єдиний in-flight `Promise`).
4. Викликається при старті **і** перед `create` (lazy self-heal); скидання прапора при
   `No such image` під час `create`.

Наслідок: після prune наступний `create` сам перетягне образ — баг зникає.

**Залежності:**
- `socket-proxy`: додати `IMAGES=1` (дозволяє pull+inspect; delete лишається заборонено, бо
  `DELETE` не ввімкнено). Це свідоме помірне розширення периметра.
- ghcr-пакет `unclaw-sandbox` має бути **публічним** (або токен у env) і публікуватися реліз-тегами;
  `docker-local` стандартизуємо на ghcr-pull замість локального one-shot build.

---

## 9. Стан сесій (Postgres)

`SessionStore` з Postgres-реалізацією замість in-memory `Map`:

```ts
interface SessionRecord {
  sessionId: string; userId: string; handle: string;
  networkMode: string; lastActivity: number; createdAt: number;
}
interface SessionStore {
  upsert(s: SessionRecord): Promise<void>;
  get(sessionId: string): Promise<SessionRecord | null>;
  delete(sessionId: string): Promise<void>;
  listByUser(userId: string): Promise<SessionRecord[]>;
  all(): Promise<SessionRecord[]>;
}
```

- Контролер стає stateless: переживає рестарт без втрати `networkMode`.
- Recovery = звірити `store.all()` проти `backend.list()`: лишити running, прибрати зомбі,
  видалити осиротілі записи.
- БД у стеку вже є (спільний Postgres платформи); окрема таблиця `sandbox_sessions`.

---

## 10. Потік даних

**create:** core → `ensureRuntime()` → `ensureMounts()` (локальний workspace) →
`backend.create(spec)` → `store.upsert()`.
**exec:** core знаходить сесію у `store` → `backend.exec(handle, cmd)` → оновлює `lastActivity`.
**files:** core працює нативним fs над workspace (живий контейнер не потрібен), захист HMAC-токеном.
**idle/evict:** core → `backend.destroy(handle)` + `store.delete()`; workspace на диску лишається.

---

## 11. Матриця інсталяцій (профілі)

| Топологія | Профіль | Backend | Runtime | Workspace | Інфра |
|---|---|---|---|---|---|
| Docker Compose self-host | `docker-local` | Docker | **runsc** (дефолт) | локальний bind | gVisor на хості |
| Coolify / PaaS | `docker-local` | Docker | **runsc** | локальний bind | gVisor на хості |
| Kubernetes (потім) | `k8s` | K8s Pods | RuntimeClass | PVC/Object | — |
| Managed (потім) | `managed` | E2B/Fly | вендор | вендор | S3 |

Цей етап реалізує лише `docker-local`. Решта — port-ready.

---

## 12. План міграції (мінімальний diff)

1. Винести `createSandbox`/`execInSandbox`/`destroySandbox`/`recoverSessions` у `DockerBackend`
   (реалізація `ComputeBackend`) — майже дослівно.
2. Перенести `detectHostDataRoot`/`toHostPath`/bind-логіку всередину `DockerBackend` (легітимна
   локальна деталь, а не розмазана по контролеру).
3. Додати `ensureRuntime()` (pull-if-missing) + дедуп.
4. Додати hardening-поля та `Runtime` у `buildSandboxConfig`; fail-closed перевірку рантайму при boot.
5. Замінити in-memory `Map` на `PostgresSessionStore`; recovery → reconcile.
6. Фабрика бекенда за `COMPUTE_BACKEND`.
7. `socket-proxy`: `IMAGES=1`. Compose `docker-local`: ghcr-pull замість local build; `scripts/install-gvisor.sh`.
8. HTTP-хендлери лишаються; прямі виклики dockerode → виклики порту/стору.

Чистий новий код: інтерфейс + фабрика + `PostgresSessionStore` + hardening/ensureRuntime. Решта — переміщення.

---

## 13. Тестування

- **Contract-test для `ComputeBackend`** — один набір поведінкових тестів, що ганяється проти
  кожної реалізації (зараз `DockerBackend`; майбутні мусять пройти той самий набір).
- **Integration: gVisor-isolation** — escape-проби: доступ до host-PID namespace, host-девайсів,
  запис поза read-only rootfs, мережа при `none` — усе має падати/блокуватися.
- **`PostgresSessionStore`** — проти реального PG (recovery/reconcile, відсутність втрати `networkMode`).
- **Regression: prune** — видалити образ, переконатися що `create` самозцілюється через `ensureRuntime`.
- **Fail-closed** — `runsc` недоступний + `SANDBOX_RUNTIME=runsc` → контролер не стартує.

---

## 14. Ризики та відомі обмеження

- **gVisor syscall-сумісність:** деякі важкі речі (частина FUSE, специфічний io_uring, GPU) можуть
  не піти. Для типового агента (python/node/git/файли) — зазвичай не проблема. Fallback на Kata
  (де є KVM) через той самий порт.
- **Host-prereq gVisor:** тертя для «zero-config». Пом'якшуємо інсталятором + fail-closed.
- **Розширення `socket-proxy` (`IMAGES=1`):** контролер зможе pull/inspect образів. Помірне; delete
  лишається заборонено.
- **Спільний адмін-ключ:** ізоляція рантайму **не** закриває цю діру — окремий follow-up на тенант-скоупінг.
- **Перехід на ghcr-pull:** вимагає публічного пакета + реліз-тегів; інакше pull не спрацює.

---

## 15. Відкриті питання

- Чи виносити `sandbox_sessions` в окрему БД/схему, чи в існуючу схему платформи?
- Чи додавати egress-allowlist (а не лише `none`/`bridge`) уже на цьому етапі, чи окремим follow-up?
- Версіонування sandbox-образу: пін `UNCLAW_VERSION` проти `latest` для уникнення version-skew
  між локально-зібраним контролером і ghcr-образом sandbox.
