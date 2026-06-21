# Дизайн: ізольований виконавчий шар sandbox-контролера

**Дата:** 2026-06-21
**Статус:** затверджено до планування (v2 — враховано зовнішнє рев'ю)
**Автор:** обговорення LyoSU + Claude

> v2 інкорпорує чотири незалежні рев'ю: додано таблицю альтернатив, секції
> продуктивності/сумісності gVisor, моделі секретів, меж мультитенантності,
> формальний reconcile, GC workspace'ів, observability; чесно знижено заяву
> «port-ready для Managed/K8s»; версіонування образу винесено з відкритих питань
> у рішення.

---

## 1. Контекст і проблема

Платформа виконує згенерований AI код у sandbox-контейнерах. Сьогодні `sandbox-controller`
напряму викликає `dockerode` поверх `socket-proxy`, тримає стан сесій у пам'яті (`Map`),
а workspace монтує bind'ом із локального диска хоста (`detectHostDataRoot`/`toHostPath`).

Це породило прод-інцидент: образ `unclaw-sandbox:latest` зник із хоста (ймовірно — автоматичне
Docker-очищення Coolify видалило «невикористовуваний» образ, бо одноразовий складальник вийшов і
жоден постійний контейнер його не тримав). Наслідок — кожен `POST /sessions` падає з
`404 No such image`, чати не працюють.

Інцидент — симптом, не корінь. Корені:

1. Життєвий цикл образу поза контролем споживача; `socket-proxy` навіть не дозволяє pull.
2. Стан у пам'яті: рестарт губить `networkMode`, обнуляє `lastActivity`; неможливо тримати >1 інстансу.
3. Прив'язка до локального диска: bind-монти з трансляцією host-path крихкі й не масштабуються на кілька нод.
4. Ізоляція: контролер root-equivalent на хості; `socket-proxy` — defense-in-depth, не межа; голі контейнери (`runc`) ділять ядро хоста.

### Модель загроз

Мультитенантно, untrusted: різні компанії/люди на одному деплої, AI виконує довільний код.
Container escape = компрометація хоста, усіх тенантів і спільного адмін-ключа. Голих контейнерів
недостатньо — потрібна сильна ізоляція виконання. Межі того, що цей етап закриває, а що ні — у §11.

---

## 2. Позиціонування

Самохостована сильна ізоляція виконання коду «з коробки», без обов'язкового платного хмарного
sandbox. У Daytona/E2B керована хмара по суті обов'язкова й дорога; Daytona навіть за замовчуванням
використовує звичайний Docker, а сильнішу ізоляцію вмикає опційно. unClaw дає сильну ізоляцію
виконання за замовчуванням і на власному VPS — через gVisor, який не потребує KVM.

Чесна межа: цей етап дає ізоляцію *виконання коду*. Повна мультитенантна ізоляція даних, мережі та
секретів — окремий follow-up (§11). Доки той follow-up не закритий, деплой слід трактувати як одну
довірчу зону (одна організація).

---

## 3. Альтернативи ізоляції (чому gVisor)

| Підхід | Ізоляція | KVM? | Запускає довільні бінарники | Старт / overhead |
|---|---|---|---|---|
| Docker `runc` | слабка (спільне ядро) | ні | так | мс, нативно |
| **Docker + gVisor (`runsc`)** | сильна (userspace-ядро, перехоп syscall) | **ні** | так | десятки мс; I/O overhead |
| Docker + Sysbox | середня (userns + трап) | ні | так (+ docker-in-docker) | мс |
| Kata / Firecracker / libkrun | найсильніша (HW-межа, своє ядро) | **так** | так | 125 мс–2 с |
| V8 isolates (Cloudflare Workers-style) | сильна | ні | **ні** (лише JS/Wasm) | <1 мс |
| Wasm / WASI | сильна, capability-based | ні | **ні** (лише скомпільоване) | мс |
| Managed (E2B/Fly/Modal) | вендорський microVM | n/a | так | суб-секунда; платно, дані в хмарі |

Обмеження unClaw разом: (а) довільні бінарники (`bash`/`python`/`pip`/`node`), (б) self-host на VPS
часто **без KVM**, (в) сильна untrusted-ізоляція, (г) flag-swap без зміни архітектури. Ці чотири
звужують поле до **gVisor**: V8/Wasm не запускають довільні бінарники; Kata/Firecracker потребують
KVM (лишаємо opt-in tier, де KVM є); Sysbox слабший за gVisor для untrusted (його мета — docker/systemd
всередині). gVisor — production-планка (Google Cloud Run / GKE Sandbox) і не потребує KVM.

---

## 4. Цілі та не-цілі

### Цілі
- Єдиний внутрішній інтерфейс `ComputeBackend`; ядро контролера не міняється при зміні рантайму/бекенду.
- Сильна ізоляція виконання untrusted-коду за замовчуванням (Docker + gVisor + hardening), fail-closed.
- Усунути prune-баг структурно (`ensureRuntime()` як передумова `create()`) + не допустити latency-спайку (boot-прогрів).
- Durable-стан сесій (Postgres) без regресії latency на hot-path.
- HTTP-контракт платформа↔контролер не міняється.

### Не-цілі (свідомо, за YAGNI)
- `WorkspaceStore`/`ObjectStore` — лишаємо локальний bind.
- `KubernetesBackend`, реалізація `ManagedBackend`.
- per-tenant `CONTROLLER_SECRET`, egress-allowlist — named follow-up (§11).
- Firecracker-snapshotting / instant-fork.

### Чесна межа готовності (виправлено за рев'ю)
Цей етап робить готовим лише **DockerBackend**. `SandboxSpec` несе локальний host-path, а файлові
ендпоінти працюють над локальним fs (§7) — тому Managed/K8s **не** «port-ready»: їх увімкнення додатково
потребує `WorkspaceStore` і перепису `/files`,`/upload`,`/download`. Порт лишається правильним швом для
*виконавчої* частини; файлова частина — наступний шар.

---

## 5. Архітектура

Hexagonal (Ports & Adapters) всередині наявного контролера. Контролер лишається єдиним мережевим швом;
усе змінне у виконавчій частині ізольоване в один порт.

```
  platform ── HTTP (контракт незмінний) ──> CONTROLLER CORE
                                            (HTTP API · auth/HMAC · quotas ·
                                             idle · eviction · recovery ·
                                             SessionStore[Postgres] · GC)
                                                      |
                                              ComputeBackend  (єдиний порт)
                                                      |
            +-----------------------+-----------------+------------------+
       DockerBackend          (Kata/Firecracker        ManagedBackend
       + gVisor(runsc)         через Runtime,           (E2B/Fly) — потребує ще
       + hardening             opt-in де є KVM)         WorkspaceStore; не зараз
       <-- ДЕФОЛТ
```

Усе спільне пишеться раз і живе над портом; кожен майбутній виконавчий бекенд — один файл.

---

## 6. Порт `ComputeBackend`

```ts
interface SandboxSpec {
  sessionId: string;
  userId: string;
  // NB: host-local шлях — Docker-специфіка. Для Managed/K8s тут згодом буде
  // opaque workspaceRef + WorkspaceStore (не цей етап, див. §4 «межа готовності»).
  wsHostPath: string;
  sharedHostPath: string;
  networkMode: "none" | "bridge";
  memoryBytes: number;
  nanoCpus: number;
}
interface ExecResult { stdout: string; stderr: string; exitCode: number; }
interface RecoveredSandbox { sessionId: string; userId: string; handle: string; running: boolean; }

interface ComputeBackend {
  ensureRuntime(): Promise<void>;                 // гарантувати образ ПЕРЕД create; ідемпотентно, з дедупом
  create(spec: SandboxSpec): Promise<{ handle: string }>;
  exec(handle: string, command: string, timeoutMs: number): Promise<ExecResult>;
  destroy(handle: string): Promise<void>;         // workspace НЕ чіпає
  list(): Promise<RecoveredSandbox[]>;            // ПОВЕРТАЄ sessionId (з лейбла) для reconcile
}
```

Вибір реалізації — `COMPUTE_BACKEND=docker` (поки лише `docker`).

---

## 7. Ядро контролера (спільне)

Переноситься з теперішнього `server.js` майже дослівно: HTTP-роутинг та API, авторизація
(`safeEqual` bearer + HMAC `workspaceToken`), квоти, eviction LRU, idle-cleanup, recovery/reconcile,
GC. Файлові ендпоінти (`/files`,`/download`,`/upload`) поки працюють нативним fs над локальним
workspace — це свідомо лишається в ядрі (не за портом), з наслідком для готовності Managed/K8s (§4).

---

## 8. Ізоляція

### Дефолт: Docker + gVisor (`runsc`)
`HostConfig.Runtime = "runsc"` у `buildSandboxConfig`. gVisor — userspace-ядро без потреби в KVM.

### Hardening-профіль (на кожен sandbox)
- `CapDrop: ["ALL"]`, `SecurityOpt: ["no-new-privileges"]`
- read-only rootfs + `tmpfs` на `/tmp`
- `PidsLimit`, mem/cpu ліміти (вже є)
- мережа `none` за замовчуванням (bridge — opt-in, ризик §11)
- **userns-remap на рівні демона — вимога для мультитенанта** (не optional): без нього root-у-контейнері
  після ескейпу = root над bind-монтованими workspace'ами інших тенантів. Перевіряється при boot.

### Профілі рантайму (фіксуємо вже зараз)
- `secure` (дефолт): `runsc`, fail-closed.
- `dev`/`trusted`: `runc` з гучним warning. Перемикається лише явним `SANDBOX_RUNTIME=runc`.

### Fail-closed
Якщо профіль `secure`/`SANDBOX_RUNTIME=runsc`, а `runsc` недоступний — контролер відмовляється
стартувати (за зразком перевірки `CONTROLLER_SECRET`). Жодного тихого фолбеку на `runc`.

### Host-prereq
`scripts/install-gvisor.sh` (встановлює `runsc`, реєструє runtime у `daemon.json`, вмикає userns-remap)
+ документація. Boot-перевірка підтверджує доступність рантайму (fail-closed вище).

---

## 9. Продуктивність і сумісність gVisor (нове, за рев'ю)

**Свідомий tradeoff:** приймаємо вищу latency й I/O-overhead в обмін на ізоляцію.

- **Платформа:** дефолт gVisor — `systrap` (не легасі `ptrace`), що суттєво швидша. Де є KVM —
  опційно `--platform=kvm` для кращої перф.
- **I/O-overhead реальний:** перехоплення syscall'ів дорожчає filesystem-важкі ворклоади (багато
  дрібних `read`/`write`/`stat`, компіляція, `pip`/`npm install`). Очікувати помітну, але не
  катастрофічну просадку проти `runc`; точні числа — з бенчмарку нижче.
- **Cold-start:** створення sandbox під `runsc` дорожче за `runc` (десятки–сотні мс). Якщо агент
  піднімає sandbox на кожне повідомлення — це user-facing; пом'якшуємо reuse сесій (вже є) і
  boot-прогрівом образу (§12).
- **Сумісність:** відомо проблемні — частина FUSE, специфічний `io_uring`, GPU, подеколи
  Docker-in-Docker. Для типового агента (python/node/git/файли/HTTP) зазвичай ОК.

**Деліверабли цього розділу (в план):**
1. Workload-compatibility matrix: реальний агентський сценарій (встановлення пакетів, білд, запуск
   сервера, git, можливо browser-automation) під `runsc` — зафіксувати що ламається.
2. Грубі бенчмарки: час `create` + типовий цикл файлів + `exec` (`runc` vs `runsc`).
3. Fallback-політика: якщо ворклоад не йде на `runsc` — Kata лише де є KVM; на VPS без KVM
   fallback неробочий, тож рішення = явна помилка з поясненням, **без** silent-downgrade на `runc`.

---

## 10. Що бачить sandbox (модель секретів та ізоляції даних) (нове, за рев'ю)

- **Docker socket:** sandbox його не бачить — лише контролер ходить до демона через `socket-proxy`.
- **Env контролера:** не успадковується; sandbox отримує лише явно задані env зі `SandboxSpec`. Жодних
  `CONTROLLER_SECRET`/`DATABASE_URL`/`UNCLAW_MASTER_KEY` усередині sandbox.
- **Workspace іншого тенанта:** bind лише власної per-session директорії + per-user `/shared`. Імена —
  `sessions/{nanoid}` (не зовнішньо-контрольовані шляхи); шляхи канонізуються (`safeRealPath`, вже є).
- **Post-escape межа:** `userns-remap` (§8) гарантує, що навіть root-у-контейнері не = root над
  хостовими файлами інших тенантів.
- **Дискова квота:** `MAX_WORKSPACE_MB` enforced контролером; для жорсткості — ФС-квота на workspace-root
  (XFS prjquota / `overlayfs` upper limit) як hardening (план §21).

---

## 11. Межі мультитенантності цього етапу (нове, за рев'ю)

Що цей етап **закриває**: ізоляцію виконання коду (gVisor), post-escape ФС-межу (userns), per-session
workspace, дискову квоту, fail-closed рантайм.

Що **НЕ закриває** (named follow-up, до прод-мультитенанта):
- **Спільний `CONTROLLER_SECRET`:** один скомпрометований тенант = всі. План: per-tenant secret.
- **Спільний egress-IP при `bridge`:** abuse одного тенанта → IP-бан для всіх. План: egress-allowlist
  (dns + pip/npm) або per-session netns; доти `bridge` — opt-in із задокументованим ризиком.
- **Позиціонування:** доки це не закрито — «сильна ізоляція виконання, single-trust-zone (одна організація)».

---

## 12. Життєвий цикл образу

`DockerBackend.ensureRuntime()`:
1. `inspect` образу → є: готово (кешований прапор «ensured»).
2. `404` → `pull` з ghcr, дочекатись `followProgress`.
3. Дедуп одночасних викликів (єдиний in-flight `Promise`); reset прапора при `No such image` під час
   `create` і re-ensure — **атомарно під тим самим м'ютексом** (уникнути гонки).
4. failure-policy: образ присутній → працюємо офлайн; pull зафейлив → `create` падає з чіткою помилкою,
   **без** фолбеку на чужий/старий образ.

**Реактивне + превентивне (за рев'ю):**
- **Boot-прогрів:** `ensureRuntime()` у стартовому gate — перший користувач не платить pull.
- **Anti-prune:** пін digest (нижче) + виключення образу з Coolify-cleanup (мітка/конфіг). Опційно —
  reference-holder-тег. Періодичний background-`ensureRuntime` (дешевий `inspect`, pull лише при 404).
- **Latency-наслідок:** холодний pull великого образу може перевищити HTTP-таймаут клієнта (504). Boot-прогрів
  робить це рідкісним; платформа має показувати дружню «середовище готується» при першому холодному старті.

**Залежності:**
- `socket-proxy`: `IMAGES=1` для pull+inspect. **Верифікувати**, що це не відкриває `POST /images/load`
  (вектор image-injection); якщо відкриває — заблокувати окремо. Delete лишається заборонено.
- **Версіонування — рішення, не питання:** пін `UNCLAW_VERSION` (ідеально — `sha256` digest);
  `latest` лише для dev. `latest` + pull-if-missing у проді = version-skew контролер↔образ. Образ
  публікується реліз-тегами; ghcr-пакет публічний (або токен у env). `docker-local` переходить на
  ghcr-pull замість локального one-shot build.

---

## 13. Стан сесій (Postgres)

`SessionStore` з Postgres замість in-memory `Map`:

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

**Hot-path (за рев'ю):** `lastActivity` НЕ пишемо в Postgres на кожен `exec` (десятки записів за сесію).
Тримаємо in-process і flush'имо періодично (раз у ~30–60 с і при idle-sweep); точність до секунди для
idle-cleanup не потрібна. Durable-записи (`upsert` при `create`, `delete` при `destroy`) — синхронні.

Окрема таблиця `sandbox_sessions` у наявній схемі платформи (рішення §23).

---

## 14. Recovery / reconcile (формалізовано, за рев'ю)

**Boot-gate:** до завершення reconcile API повертає `503` (readiness, §19) — не обслуговуємо `POST /sessions`
під час відновлення.

**Ключ зіставлення — `sessionId`** (лейбл `unclaw.session` на контейнері), не `handle` (id може змінитися).
`backend.list()` повертає `sessionId`.

| Postgres | Backend (за `sessionId`) | Дія |
|---|---|---|
| є, running | є, running | keep (відновити запис у пам'ять) |
| є | немає | видалити запис (зомбі-сесія) |
| немає | є, running | прибрати контейнер (осиротілий) |
| є, running | є, stopped/exited | прибрати контейнер + видалити запис (lazy-recreate при наступному `create`) |
| є | backend недоступний | не чіпати, лишити запис, повторити reconcile |

**Mid-op invalidation:** якщо `exec`/op повертає `No such container` (контейнер впав, напр. OOM) —
інвалідувати запис у Postgres і повернути платформі чітку помилку (сесію можна перестворити).

---

## 15. Життєвий цикл workspace + GC (нове, за рев'ю)

- `destroy` прибирає контейнер; workspace на диску лишається (переживає idle/eviction) — навмисно.
- **Наслідок:** без прибирання директорії осиротілих сесій накопичуються → переповнення диска на
  мультитенант-VPS. Додаємо **background GC**: періодично видаляти `wsHostPath` для сесій, яких немає в
  Postgres і старших за поріг (grace). GC — окремий таймер у контролері, ідемпотентний, з логуванням.
- **Контракт ephemeral-стану:** усе всередині контейнера (tmpfs, rootfs) — ephemeral; персист лише у
  workspace. Документуємо для платформи/користувачів, щоб idle-TTL не сприймався як «втрата роботи».

---

## 16. Потік даних

- **create:** core → `ensureRuntime()` → `ensureMounts()` → `backend.create(spec)` → `store.upsert()`.
- **exec:** core → `store.get` → `backend.exec(handle, cmd)` → in-process `lastActivity`.
- **files:** core → нативний fs над workspace (живий контейнер не потрібен), захист HMAC-токеном.
- **idle/evict/GC:** `backend.destroy(handle)` + `store.delete()`; GC прибирає диск пізніше.

---

## 17. Матриця інсталяцій (профілі)

| Топологія | Профіль | Backend | Runtime | Workspace | Готовність |
|---|---|---|---|---|---|
| Docker Compose self-host | `docker-local` | Docker | `runsc` (дефолт) | локальний bind | **цей етап** |
| Coolify / PaaS | `docker-local` | Docker | `runsc` | локальний bind | **цей етап** |
| Kubernetes | `k8s` | K8s Pods | RuntimeClass | PVC/Object | потребує WorkspaceStore |
| Managed | `managed` | E2B/Fly | вендор | вендор | потребує WorkspaceStore |

---

## 18. Observability та audit (нове, за рев'ю)

- **Structured logs** з correlation/trace-id на сесію (хто/коли/`sessionId`/`handle`/образ-тег).
- **Audit-trail lifecycle:** create / exec(метадані, не вміст) / destroy / evict / recover.
- **Метрики:** latency `create` (з/без pull), latency `exec`, причини помилок, к-сть активних сесій,
  gVisor-specific помилки, спрацювання GC/eviction.

---

## 19. Health: liveness vs readiness (нове, за рев'ю)

- **liveness:** процес живий.
- **readiness:** reconcile завершено + Docker-демон і `runsc` доступні + Postgres досяжний. До readiness
  Coolify/оркестратор не шле трафік; API відповідає `503` (узгоджено з boot-gate §14).

---

## 20. План міграції (мінімальний diff)

1. Винести `createSandbox`/`execInSandbox`/`destroySandbox`/`recoverSessions` у `DockerBackend`.
2. Перенести `detectHostDataRoot`/`toHostPath`/bind-логіку всередину `DockerBackend`.
3. `ensureRuntime()` (pull-if-missing) + дедуп/atomic-reset + boot-прогрів.
4. Hardening-поля + `Runtime` у `buildSandboxConfig`; профілі `secure`/`dev`; fail-closed + userns-перевірка при boot.
5. `PostgresSessionStore` + in-process `lastActivity` flush; reconcile за таблицею §14 + boot-gate.
6. Background GC workspace'ів.
7. Фабрика бекенда за `COMPUTE_BACKEND`.
8. `socket-proxy`: `IMAGES=1` (+ перевірка `/images/load`). Compose `docker-local`: ghcr-pull, пін
   `UNCLAW_VERSION`/digest; `scripts/install-gvisor.sh`.
9. Observability/health (§18–19). HTTP-хендлери лишаються; прямі виклики dockerode → порт/стор.

---

## 21. Тестування

- **Contract-test `ComputeBackend`** — один набір проти кожної реалізації (пріоритет №1: тримає порт чесним).
- **gVisor isolation-проби:** доступ до host-PID/девайсів, запис поза read-only rootfs, мережа при `none` — мають падати.
- **gVisor workload-compatibility matrix** (§9.1) + бенчмарки (§9.2).
- **`PostgresSessionStore` + reconcile:** усі рядки таблиці §14, mid-op invalidation, відсутність втрати `networkMode`.
- **Regression prune:** видалити образ → `create` самозцілюється; перевірити boot-прогрів.
- **Fail-closed:** `runsc` недоступний + `secure` → контролер не стартує.
- **GC:** осиротілі директорії прибираються після grace; живі — ні.
- **Дискова квота:** перевищення `MAX_WORKSPACE_MB` блокується.

---

## 22. Ризики та відомі обмеження

- **gVisor сумісність/перф (найбільший ризик етапу):** мітигація — workload-matrix + бенчмарки до того,
  як `runsc` стане дефолтом; чесна failure-policy без silent-downgrade.
- **Workspace stateful:** контролер stateless щодо стану сесій, але workspace на локальному диску → фактично
  single-instance. Multi-instance потребує `WorkspaceStore` (поза цим етапом).
- **Мультитенант не закритий повністю:** §11 (secret/egress) — named follow-up.
- **Host-prereq gVisor:** тертя для zero-config; мітигація — інсталятор + fail-closed.
- **`socket-proxy IMAGES=1`:** ширший периметр; верифікувати `/images/load`.
- **Перехід на ghcr-pull:** вимагає публічного пакета + реліз-тегів/digest.
- **Supply chain образу:** пін digest; cosign-верифікація — бажано (follow-up).

---

## 23. Рішення (закриті колишні відкриті питання) та залишкові питання

**Рішення:**
- Версіонування образу: пін `UNCLAW_VERSION`/digest, `latest` лише dev (§12).
- `sandbox_sessions`: окрема таблиця в наявній схемі платформи (спрощує бекап/деплой; `userId` уже зав'язаний на користувачів).
- Egress: дефолт `none`; `bridge` opt-in із задокументованим ризиком; allowlist — named follow-up (§11).
- Профілі рантайму `secure`/`dev` фіксуємо зараз (§8).

**Залишкові відкриті питання:**
- Чи достатній gVisor для вашої threat model, чи enterprise-мультитенант усе ж вимагатиме обов'язкового
  Kata/Firecracker tier (на KVM-нодах)? — рішення після workload-matrix/бенчмарків (§9).
- Механіка ФС-квоти (XFS prjquota vs overlayfs upper) — обрати в реалізації §10.
- Формат cosign-верифікації образу — окремий follow-up.
