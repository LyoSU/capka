# Видимість вкладень в історії чату

**Дата:** 2026-06-20
**Статус:** draft

## Проблема

Коли користувач прикріплює фото/файл у вебчаті, файл вивантажується в sandbox
(`/api/sandbox/files/upload`), а повідомлення користувача зберігається як **чистий
текст** (`use-background-chat.ts` → `displayText`, з коментарем «clean text only, no
file metadata»). Наслідок:

- **В історії чату не видно**, що користувач щось прикріплював — бульбашка показує
  лише текст (або заглушку «Process the attached files»).
- Слід вкладень (`ContextSection` у workspace-панелі) зникає одразу після надсилання
  (`setFiles([])`), бо він показує лише ще не надіслані файли.

## Що вже працює (і не міняється)

Знання ШІ про прикріплені файли **вже реалізоване** і коду не потребує:

- `route.ts` кладе `attachedFiles` у `TaskPayload`.
- `runner.ts` передає `payload.attachedFiles` у `buildSystemPrompt`, який додає
  volatile-блок «User just attached these files: …» (`prompt.ts`).
- `injectNativeFiles` (`runner.ts`) підкидає реальні байти нативних зображень як
  `FilePart` в останнє user-повідомлення поточного прогону.
- Після цього файли лишаються в `/workspace` і потрапляють у workspace-snapshot
  щопрогону, тож модель бачить, що вони існують.

Тому AI-частина (`runner.ts`, `prompt.ts`, схема БД, кеш) **не чіпається взагалі**.

## Кеш — чому зміни безпечні

Anthropic prompt caching ієрархічний: `tools → system → messages`. У проєкті є рівно
одна точка кешу — `cacheControl: ephemeral` на *stable* system-префіксі
(`runner.ts`). Картинки/текст у повідомленнях інвалідовують лише рівень `messages`
(якого тут немає), а **system-кеш не чіпають**. Цей дизайн не торкається ні
system-префіксу, ні модельного контексту — він лише зберігає легкі метадані та
рендерить їх на клієнті. Кеш недоторканий за побудовою.

## Принцип: reference, не байти

Важкі байти не потрапляють ні в БД, ні в промпт. Зберігаємо лише `FileRef`
(`{ name, type }`). Тумбнейли в історії підвантажуються **ліниво з sandbox** через
наявний download-ендпоінт (`inline=1`) — суто клієнтський фетч, поза промптом. Це той
самий reference-підхід, що вже використано в проєкті для нативних файлів.

## Дизайн

Мінімум нового коду; максимум перевикористання наявних примітивів
(`FileThumb`, `usePreview`/Quick Look, `FileRef`, `metadata` jsonb). Схему БД не
міняємо — колонка `messages.metadata` уже `jsonb`.

### 1. Сховище метаданих — `src/lib/chat/contracts.ts`

Додати поле у тип `MessageMeta`:

```ts
export type MessageMeta = {
  // …існуючі поля…
  /** Файли, які користувач прикріпив до ЦЬОГО повідомлення (reference-метадані,
   *  без байтів). Форма збігається з FileRef і chatRequestSchema.attachedFiles. */
  attachedFiles?: { name: string; type: string }[];
};
```

### 2. Запис при надсиланні — `src/app/api/chat/route.ts`

У блоці вставки user-повідомлення додати `metadata`:

```ts
await db.insert(messages).values({
  id: newUserId,
  chatId,
  parentId,
  role: "user",
  content: text,
  platform: "web",
  metadata: attachedFiles?.length ? { attachedFiles } : null,
}).onConflictDoNothing();
```

(`attachedFiles` уже розпарсений зі `chatRequestSchema`.)

### 3. Презентер — `src/lib/chat/presenter.ts`

У `toUIMessages` додати `attachedFiles` у повернуті `metadata` поряд із
`siblingIndex`/`platform`:

```ts
metadata: {
  // …існуючі поля…
  attachedFiles: meta?.attachedFiles,
},
```

### 4. Оптимістичне повідомлення — `src/hooks/use-background-chat.ts`

Щоб чипи з'явилися миттєво (до reload історії), оптимістичному `userMsg` додати
метадані:

```ts
const userMsg: Message = {
  id: nanoid(),
  role: "user",
  parts: [{ type: "text", text: displayText }],
  metadata: uploadedFiles.length > 0 ? { attachedFiles: uploadedFiles } : undefined,
};
```

Більше нічого в хуку не змінюється (потік аплоуду та `sendMessage` лишаються).

### 5. Візуал у бульбашці — `src/components/chat/message.tsx`

- У `ChatMessageImpl` прочитати `metadata.attachedFiles` і передати разом із `chatId`
  у `UserBubble`.
- У `UserBubble` над текстовою бульбашкою (вирівняно праворуч) показати ряд тайлів.
  Кожен тайл — наявний `FileThumb` із `{ path: name, name, chatId }`; клік відкриває
  Quick Look через `usePreview().open(files, index)`.
- Якщо тексту немає (були лише файли), не показувати заглушку «…» — самі тайли є
  достатнім вмістом.

Псевдокод нового підкомпонента (єдиний справді новий UI):

```tsx
function MessageAttachments({ chatId, files }: { chatId: string; files: FileRef[] }) {
  const { open } = usePreview();
  const previewFiles = files.map((f) => ({ path: f.name, name: f.name, chatId }));
  return (
    <div className="mb-1 flex flex-wrap justify-end gap-2">
      {previewFiles.map((f, i) => (
        <button key={f.path} type="button" onClick={() => open(previewFiles, i)}
                className="…" aria-label={…}>
          <FileThumb file={f} className="h-16 w-16 rounded-lg" />
        </button>
      ))}
    </div>
  );
}
```

`chatId` для рендеру в `message.tsx` уже доступний як проп; `PreviewProvider` уже
обгортає панель (`chat-panel.tsx`).

### 6. i18n

Нових рядків майже немає. Для `aria-label`/`title` тайла перевикористати наявні ключі
`chat.preview.*` (open/download/close) або додати один ключ
`chat.message.attachment` («Вкладення {name}» / «Attachment {name}») у `messages/uk.json`
і `messages/en.json`. Текст системного промпту лишається англійським — не міняється.

## Поза скоупом

- **Telegram-вхід медіа.** `bot.ts` приймає лише `message:text`; прийому фото/файлів
  немає взагалі — це окрема фіча.
- **Крос-історична AI-нотатка** (per-turn linkage «на кроці N додано X»). Не потрібна:
  поточний крок уже покрито volatile-промптом, а існування файлів — workspace-snapshot.
  Додається адитивно пізніше за потреби.

## Тестування

- **Презентер** (`src/lib/chat/__tests__` або наявний тест-набір): рядок із
  `metadata.attachedFiles` → `attachedFiles` доходить до UI-метаданих; рядок без них →
  `undefined`.
- **Ручна перевірка**: прикріпити зображення + PDF, надіслати; переконатися, що тайли
  з'являються миттєво (оптимістично), переживають reload історії, відкривають Quick
  Look, і що тумбнейл зображення підвантажується ліниво з sandbox.

## Зведення дотиків коду

| Файл | Зміна | Розмір |
|------|-------|--------|
| `src/lib/chat/contracts.ts` | поле `attachedFiles` у `MessageMeta` | ~3 рядки |
| `src/app/api/chat/route.ts` | `metadata` при вставці user-повідомлення | ~1 рядок |
| `src/lib/chat/presenter.ts` | прокинути `attachedFiles` у UI-метадані | ~1 рядок |
| `src/hooks/use-background-chat.ts` | `metadata` на оптимістичному повідомленні | ~1 рядок |
| `src/components/chat/message.tsx` | `MessageAttachments` + проброс пропсів | ~20 рядків |
| `messages/{uk,en}.json` | максимум 1 ключ для aria-label | ~2 рядки |

Жодних змін у `runner.ts`, `prompt.ts`, схемі БД чи логіці кешування.
