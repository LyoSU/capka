/**
 * A flat index of every setting, so "where do I change X" stops being a question
 * the user has to answer by opening pages one at a time.
 *
 * Entries are DECLARED here rather than scraped from the rendered pages: a page is
 * a client component whose text only exists once React has run it, and half the
 * pages are admin-only, so there is nothing to scrape from the sidebar's point of
 * view. The cost of declaring is that a new setting has to be added here too —
 * which is exactly what `__tests__/directory.test.ts` checks, by requiring every
 * entry to name a page that exists and a translation key that resolves.
 *
 * `label` and `hint` are i18n key paths resolved by the caller against the root
 * catalog, so the search reads the SAME words as the page it links to. `keywords`
 * are extra untranslated-in-place terms (both languages in one string): what
 * someone actually types when they don't know our vocabulary — "промпт" for
 * instructions, "gpt" for providers.
 */
export interface SettingsEntry {
  /** Page path plus the row's anchor id, e.g. "/settings/agent#agent-instructions". */
  href: string;
  /** i18n key path for the row's own name. */
  label: string;
  /** i18n key path for the page this lives on — shown as the result's breadcrumb. */
  page: string;
  /** Extra search terms, space-separated, in both locales. Never displayed. */
  keywords?: string;
  adminOnly?: boolean;
}

export const SETTINGS_DIRECTORY: SettingsEntry[] = [
  // ── Personal ──────────────────────────────────────────────────────────────
  { href: "/settings", label: "settings.general.name", page: "settings.nav.general", keywords: "ім'я name profile профіль" },
  { href: "/settings", label: "settings.general.theme", page: "settings.nav.general", keywords: "тема dark light темна світла appearance вигляд" },
  { href: "/settings", label: "language.label", page: "settings.nav.general", keywords: "мова language локаль locale" },
  { href: "/settings", label: "settings.integrations.link.title", page: "settings.nav.general", keywords: "telegram телеграм акаунт account" },
  { href: "/settings/memory#memory-enabled", label: "settings.memory.enabled", page: "settings.nav.memory", keywords: "пам'ять memory забути forget нотатки notes" },
  { href: "/settings/memory", label: "settings.memory.userTitle", page: "settings.nav.memory", keywords: "про мене about me факти facts" },
  { href: "/settings/connections", label: "settings.connections.title", page: "settings.nav.connections", keywords: "ключ key api openai anthropic gpt claude модель model провайдер" },
  { href: "/settings/skills", label: "settings.skills.title", page: "settings.nav.skills", keywords: "навички skills конектори connectors mcp плагіни plugins маркетплейс" },
  { href: "/settings/automations", label: "settings.automations.title", page: "settings.nav.automations", keywords: "розклад schedule cron автоматизації нагадування" },

  // ── Organization ──────────────────────────────────────────────────────────
  { href: "/settings/agent#agent-instructions", label: "settings.agent.instructions.title", page: "settings.nav.agent", keywords: "промпт prompt system системний інструкції instructions персона persona тон tone", adminOnly: true },
  { href: "/settings/agent#sandbox-enabled", label: "settings.agent.abilities.sandbox", page: "settings.nav.agent", keywords: "пісочниця sandbox код code файли files виконувати run", adminOnly: true },
  { href: "/settings/agent#agent-autonomy", label: "settings.agent.autonomy.title", page: "settings.nav.agent", keywords: "автономний autonomous підтвердження confirm дозвіл", adminOnly: true },
  { href: "/settings/agent#agent-mode", label: "settings.agent.mode.title", page: "settings.nav.agent", keywords: "режим mode raw чистий промпт пам'ять memory можливості capabilities", adminOnly: true },
  { href: "/settings/users", label: "settings.usersPage.title", page: "settings.nav.users", keywords: "користувачі users роль role admin адмін доступ approve схвалити", adminOnly: true },
  { href: "/settings/authentication", label: "settings.authentication.mode.title", page: "settings.nav.authentication", keywords: "реєстрація registration signup вхід login закрити", adminOnly: true },
  { href: "/settings/authentication", label: "settings.authentication.telegram.title", page: "settings.nav.authentication", keywords: "telegram телеграм oidc вхід login", adminOnly: true },
  { href: "/settings/permissions", label: "settings.permissions.title", page: "settings.nav.permissions", keywords: "дозволи permissions заборонити deny allow політика policy", adminOnly: true },
  { href: "/settings/billing", label: "settings.billing.mode.title", page: "settings.nav.billing", keywords: "спільний ключ shared key власний own", adminOnly: true },
  { href: "/settings/billing", label: "settings.billing.limits.title", page: "settings.nav.billing", keywords: "ліміт limit бюджет budget витрати spend гроші", adminOnly: true },
  { href: "/settings/integrations", label: "settings.integrations.telegram.title", page: "settings.nav.integrations", keywords: "telegram телеграм бот bot токен token botfather", adminOnly: true },
  { href: "/settings/security", label: "settings.security.encryptionKey", page: "settings.nav.security", keywords: "шифрування encryption master key ключ", adminOnly: true },
  { href: "/settings/security#sandbox-network", label: "settings.security.sandboxNet", page: "settings.nav.security", keywords: "інтернет internet мережа network egress", adminOnly: true },
  { href: "/settings/security#block-private-urls", label: "settings.security.blockPrivate", page: "settings.nav.security", keywords: "ssrf приватні private localhost внутрішні", adminOnly: true },
  { href: "/settings/security#host-folders", label: "settings.security.hostFolders", page: "settings.nav.security", keywords: "теки folders сервер server монтувати mount", adminOnly: true },
  { href: "/settings/security#pc-folders", label: "settings.security.pcFolders", page: "settings.nav.security", keywords: "теки folders комп'ютер computer синхронізація sync", adminOnly: true },
  { href: "/settings/usage", label: "settings.usage.title", page: "settings.nav.usage", keywords: "аналітика analytics витрати cost токени tokens статистика", adminOnly: true },
  { href: "/settings/activity", label: "settings.activity.title", page: "settings.nav.activity", keywords: "журнал log аудит audit історія history зміни", adminOnly: true },
  { href: "/settings/updates", label: "settings.updates.title", page: "settings.nav.updates", keywords: "оновлення update версія version релiз", adminOnly: true },
];

/**
 * Rank entries against a typed query.
 *
 * Substring matching on purpose, not fuzzy: a settings list is ~28 short items,
 * and fuzzy matching on a set that small mostly produces confident nonsense (a
 * two-letter query "мо" happily "matches" everything). A prefix hit outranks a
 * mid-word hit, and a hit in the visible label outranks one in the hidden
 * keywords — so typing "пам" puts the memory switch above the analytics page that
 * merely lists the word.
 */
export function searchSettings(
  entries: SettingsEntry[],
  query: string,
  resolve: (key: string) => string,
): SettingsEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: { entry: SettingsEntry; score: number }[] = [];
  for (const entry of entries) {
    const label = resolve(entry.label).toLowerCase();
    const page = resolve(entry.page).toLowerCase();
    const keywords = (entry.keywords ?? "").toLowerCase();

    let score = 0;
    if (label.startsWith(q)) score = 100;
    else if (label.includes(q)) score = 80;
    else if (page.startsWith(q)) score = 60;
    else if (keywords.split(/\s+/).some((w) => w.startsWith(q))) score = 40;
    else if (page.includes(q) || keywords.includes(q)) score = 20;

    if (score > 0) scored.push({ entry, score });
  }

  // Stable within a score band, so equal matches keep the declared order (which
  // follows the sidebar) instead of shuffling as the query grows.
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}
