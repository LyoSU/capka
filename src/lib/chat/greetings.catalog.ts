import type { Greeting } from "@/lib/chat/greeting";

// The pool of new-chat greetings. The engine (`greeting.ts`) reads the moment
// and picks one that fits — this file is just data and is meant to GROW.
//
// How a line is chosen:
//   - Every condition you set must hold (time/weekdays/months/seasons/weekend).
//     Leave a dimension out and it matches any value of it.
//   - A line with `{name}` is only shown when the user's first name is known;
//     keep a healthy floor of name-less time-of-day lines so there's always
//     something to show.
//   - More specific lines (more conditions) are likelier to win *when their
//     moment comes*, so a Friday-evening line isn't drowned out by generics.
//
// weekday numbers: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat.
//
// NAMES: `{name}` is substituted in the NOMINATIVE case (no vocative yet). In
// Ukrainian that's only correct when the name is the grammatical SUBJECT
// ("{name} вже за роботою?"), never a vocative address ("Доброго ранку, {name}!"
// would want "Йосипе"). English carries no such constraint — address directly
// there. The two locales are tone-equivalent, not literal translations.
//
// SELF-REFERENCE: keep the assistant genderless — avoid predicate adjectives
// about itself ("готовий"/"готова"). Prefer verbs ("допоможу", "я поруч").

export const GREETINGS: Greeting[] = [
  // ── Morning (05–11) ──────────────────────────────────────────────────────
  { id: "morning-1", time: ["morning"], text: { uk: "Доброго ранку! З чого почнемо?", en: "Good morning! Where do we start?" } },
  { id: "morning-2", time: ["morning"], text: { uk: "Ранок. Над чим попрацюємо?", en: "Morning. What are we working on?" } },
  { id: "morning-3", time: ["morning"], weight: 0.7, text: { uk: "Кава ще тепла? Берімося.", en: "Coffee still warm? Let's get to it." } },
  { id: "morning-name-1", time: ["morning"], text: { uk: "Доброго ранку! {name} вже за роботою?", en: "Morning, {name}! Up and at it?" } },
  { id: "morning-name-2", time: ["morning"], text: { uk: "Новий день. Що планує {name}?", en: "New day. What's on your plate, {name}?" } },

  // ── Afternoon (12–16) ──────────────────────────────────────────────────────
  { id: "afternoon-1", time: ["afternoon"], text: { uk: "Доброго дня! Чим допомогти?", en: "Good afternoon! How can I help?" } },
  { id: "afternoon-2", time: ["afternoon"], text: { uk: "Екватор дня. Тримаємо темп?", en: "Midday mark. Keeping the pace?" } },
  { id: "afternoon-3", time: ["afternoon"], weight: 0.7, text: { uk: "Що на черзі?", en: "What's next on the list?" } },
  { id: "afternoon-name-1", time: ["afternoon"], text: { uk: "Радий бачити. Що скаже {name}?", en: "Good to see you, {name}. What's up?" } },
  { id: "afternoon-name-2", time: ["afternoon"], text: { uk: "День у розпалі. {name} продовжує?", en: "Day's in full swing — carry on, {name}?" } },

  // ── Evening (17–21) ──────────────────────────────────────────────────────
  { id: "evening-1", time: ["evening"], text: { uk: "Доброго вечора! Над чим працюємо?", en: "Good evening! What are we working on?" } },
  { id: "evening-2", time: ["evening"], text: { uk: "День добігає кінця. Підбиваємо підсумки?", en: "Day's winding down. Wrapping up?" } },
  { id: "evening-3", time: ["evening"], weight: 0.7, text: { uk: "Спокійного вечора. Що вирішуємо?", en: "Quiet evening. What are we solving?" } },
  { id: "evening-name-1", time: ["evening"], text: { uk: "Вже вечір. {name} додає останні штрихи?", en: "Evening already — final touches, {name}?" } },
  { id: "evening-name-2", time: ["evening"], text: { uk: "Доброго вечора! Чим допомогти, {name}?", en: "Good evening, {name}. How can I help?" } },

  // ── Night (22–04) — the "still up?" zone ───────────────────────────────────
  { id: "night-1", time: ["night"], text: { uk: "Ще не спите? Я поруч.", en: "Still up? I'm here." } },
  { id: "night-2", time: ["night"], text: { uk: "Нічна зміна? Берімося.", en: "Night shift? Let's go." } },
  { id: "night-3", time: ["night"], weight: 0.6, text: { uk: "Пізня година. Я нікуди не поспішаю.", en: "Late hour. I'm in no hurry." } },
  { id: "night-name-1", time: ["night"], text: { uk: "Місто спить, а {name} працює. Я з вами.", en: "City's asleep, {name}'s not. I'm with you." } },

  // ── Monday ──────────────────────────────────────────────────────────────
  { id: "monday-1", weekdays: [1], time: ["morning", "afternoon"], weight: 1.3, text: { uk: "Новий тиждень. З чого почнемо?", en: "Fresh week. Where do we begin?" } },
  { id: "monday-2", weekdays: [1], time: ["morning"], weight: 1.1, text: { uk: "Легкого старту тижня.", en: "Easy start to the week." } },
  { id: "monday-name", weekdays: [1], time: ["morning", "afternoon"], weight: 1.1, text: { uk: "Понеділок. {name} задає темп?", en: "Monday — set the pace, {name}?" } },

  // ── Friday ────────────────────────────────────────────────────────────────
  { id: "friday-1", weekdays: [5], time: ["afternoon", "evening"], weight: 1.4, text: { uk: "П'ятниця! Закриваємо справи?", en: "It's Friday! Let's wrap things up?" } },
  { id: "friday-2", weekdays: [5], time: ["afternoon"], weight: 1.1, text: { uk: "Фінішна пряма тижня. Що лишилось?", en: "Home stretch of the week. What's left?" } },
  { id: "friday-eve", weekdays: [5], time: ["evening"], weight: 1.4, text: { uk: "Тиждень позаду. Вимикаємо систему?", en: "Week's behind us. Powering down?" } },

  // ── Weekend ───────────────────────────────────────────────────────────────
  { id: "weekend-1", weekend: true, weight: 1.1, text: { uk: "Вихідні, а ви тут. Поважаю — чим допомогти?", en: "Weekend, and here you are. Respect — how can I help?" } },
  { id: "weekend-2", weekend: true, time: ["afternoon", "evening"], text: { uk: "Спокійних вихідних. Що на черзі?", en: "Easy weekend. What's on the agenda?" } },
  { id: "weekend-night", weekend: true, time: ["night"], weight: 1.4, text: { uk: "Ніч вихідного, а ми працюємо?", en: "Weekend night and we're working?" } },

  // ── Seasonal ──────────────────────────────────────────────────────────────
  { id: "winter-morning", seasons: ["winter"], time: ["morning"], weight: 1.1, text: { uk: "Морозний ранок. Тут тепло — розпочнімо?", en: "Frosty morning. Warm in here — shall we begin?" } },
  { id: "winter-evening", seasons: ["winter"], time: ["evening"], weight: 0.8, text: { uk: "Зимовий вечір — час затишної роботи.", en: "Winter evening — cosy work time." } },
  { id: "spring", seasons: ["spring"], time: ["morning", "afternoon"], weight: 0.8, text: { uk: "Весна за вікном. Час для свіжих ідей.", en: "Spring outside. Time for fresh ideas." } },
  { id: "summer", seasons: ["summer"], time: ["afternoon", "evening"], weight: 0.8, text: { uk: "Літо кличе, а робота чекає. Берімося?", en: "Summer's calling, work's waiting. Shall we?" } },
  { id: "autumn-evening", seasons: ["autumn"], time: ["evening"], weight: 0.9, text: { uk: "Осінній вечір — ідеально для спокійної роботи.", en: "Autumn evening — perfect for quiet work." } },

  // ── Easter eggs (narrow combos — rare, but specificity makes them likely
  //    the moment their exact slot hits) ──────────────────────────────────────
  { id: "friday-night", weekdays: [5], time: ["night"], weight: 1.6, text: { uk: "П'ятнична ніч у роботі. Це вже спорт.", en: "Friday night, still working. That's a sport now." } },
  { id: "sunday-evening", weekdays: [0], time: ["evening"], weight: 1.4, text: { uk: "Недільний вечір. Розганяємось перед тижнем?", en: "Sunday evening. Spinning up for the week?" } },
  { id: "winter-monday-morning", weekdays: [1], time: ["morning"], seasons: ["winter"], weight: 1.8, text: { uk: "Зимовий понеділок. Найважче позаду — далі легше.", en: "Winter Monday. The hard part's done — easy from here." } },
  { id: "summer-friday-eve", weekdays: [5], time: ["evening"], seasons: ["summer"], weight: 1.8, text: { uk: "Літня п'ятниця, а ви тут. Швидко закругляємось?", en: "Summer Friday, and here you are. Quick wrap-up?" } },
  { id: "deep-night-name", weekdays: [1, 2, 3, 4, 5], time: ["night"], weight: 1.5, text: { uk: "Робочий тиждень, глупа ніч, а {name} не здається.", en: "Weeknight this late, and {name} won't quit." } },

  // ── Minimal / any-time floor (low weight, rare) ────────────────────────────
  { id: "minimal-1", weight: 0.4, text: { uk: "Чим можу допомогти?", en: "How can I help?" } },
  { id: "minimal-2", weight: 0.4, text: { uk: "Слухаю вас.", en: "I'm listening." } },
  { id: "minimal-3", weight: 0.4, text: { uk: "Який документ відкриємо?", en: "Which document shall we open?" } },
];
