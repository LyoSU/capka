/**
 * A flat index of every setting, so "where do I change X" stops being a question
 * the user has to answer by opening pages one at a time.
 *
 * Entries are DECLARED here rather than scraped from the rendered pages: a page is
 * a client component whose text only exists once React has run it, and half the
 * pages are admin-only, so there is nothing to scrape from the sidebar's point of
 * view. The cost of declaring is that a new setting has to be added here too —
 * which is exactly what `__tests__/settings-directory.test.ts` checks, by requiring every
 * entry to name a page that exists and a translation key that resolves.
 *
 * `label`, `page` and `keywordsKey` are i18n key paths resolved by the caller
 * against the root catalog, so the search reads the SAME words as the page it
 * links to. The keyword lists carry what someone actually types when they don't
 * know our vocabulary ("gpt" for providers) — and each locale's list also carries
 * the English jargon, since a non-English speaker still types `prompt`.
 */
export interface SettingsEntry {
  /** Page path plus the row's anchor id, e.g. "/settings/agent#agent-instructions". */
  href: string;
  /** i18n key path for the row's own name. */
  label: string;
  /** i18n key path for the page this lives on — shown as the result's breadcrumb. */
  page: string;
  /** i18n key path for the row's extra search terms, space-separated. Never displayed. */
  keywordsKey?: string;
  adminOnly?: boolean;
  /** Visible to a non-admin only while the instance lets them bring their own key.
   *  Distinct from `adminOnly`, which hides a row from non-admins outright. */
  needsOwnKeys?: boolean;
}

/**
 * The entries a given viewer may see.
 *
 * Shared rather than re-derived per surface: the settings sidebar and the ⌘K
 * palette list the same directory, and when only one of them applied the own-keys
 * rule a member on a shared-key instance could reach the provider-key page through
 * the palette — the one thing this product keeps admin-only on purpose.
 */
export function visibleSettings(
  entries: SettingsEntry[],
  { isAdmin, ownKeysAllowed }: { isAdmin: boolean; ownKeysAllowed: boolean },
): SettingsEntry[] {
  return entries.filter(
    (e) => (!e.adminOnly || isAdmin) && (!e.needsOwnKeys || isAdmin || ownKeysAllowed),
  );
}

export const SETTINGS_DIRECTORY: SettingsEntry[] = [
  // ── Personal ──────────────────────────────────────────────────────────────
  { href: "/settings", label: "settings.general.name", page: "settings.nav.general", keywordsKey: "settings.search.profile" },
  { href: "/settings", label: "settings.general.theme", page: "settings.nav.general", keywordsKey: "settings.search.theme" },
  { href: "/settings", label: "language.label", page: "settings.nav.general", keywordsKey: "settings.search.language" },
  { href: "/settings", label: "settings.integrations.link.title", page: "settings.nav.general", keywordsKey: "settings.search.telegramAccount" },
  { href: "/settings/memory#memory-enabled", label: "settings.memory.enabled", page: "settings.nav.memory", keywordsKey: "settings.search.memoryEnabled" },
  { href: "/settings/memory", label: "settings.memory.title", page: "settings.nav.memory", keywordsKey: "settings.search.memoryFacts" },
  { href: "/settings/connections", label: "settings.connections.title", page: "settings.nav.connections", keywordsKey: "settings.search.connections", needsOwnKeys: true },
  { href: "/settings/skills", label: "settings.skills.title", page: "settings.nav.skills", keywordsKey: "settings.search.skills" },
  { href: "/settings/automations", label: "settings.automations.title", page: "settings.nav.automations", keywordsKey: "settings.search.automations" },

  // ── Organization ──────────────────────────────────────────────────────────
  { href: "/settings/agent#agent-instructions", label: "settings.agent.instructions.title", page: "settings.nav.agent", keywordsKey: "settings.search.agentInstructions", adminOnly: true },
  { href: "/settings/agent#sandbox-enabled", label: "settings.agent.abilities.sandbox", page: "settings.nav.agent", keywordsKey: "settings.search.sandbox", adminOnly: true },
  { href: "/settings/agent#agent-autonomy", label: "settings.agent.autonomy.title", page: "settings.nav.agent", keywordsKey: "settings.search.autonomy", adminOnly: true },
  { href: "/settings/agent#agent-mode", label: "settings.agent.mode.title", page: "settings.nav.agent", keywordsKey: "settings.search.agentMode", adminOnly: true },
  { href: "/settings/users", label: "settings.usersPage.title", page: "settings.nav.people", keywordsKey: "settings.search.users", adminOnly: true },
  { href: "/settings/users?tab=signin", label: "settings.authentication.mode.title", page: "settings.nav.people", keywordsKey: "settings.search.signin", adminOnly: true },
  { href: "/settings/users?tab=signin", label: "settings.authentication.telegram.title", page: "settings.nav.people", keywordsKey: "settings.search.telegramAuth", adminOnly: true },
  { href: "/settings/skills?tab=permissions", label: "settings.permissions.title", page: "settings.nav.skills", keywordsKey: "settings.search.permissions", adminOnly: true },
  { href: "/settings/billing", label: "settings.billing.mode.title", page: "settings.nav.billing", keywordsKey: "settings.search.billingMode", adminOnly: true },
  { href: "/settings/billing", label: "settings.billing.limits.title", page: "settings.nav.billing", keywordsKey: "settings.search.billingLimits", adminOnly: true },
  { href: "/settings/agent#telegram-bot", label: "settings.integrations.telegram.title", page: "settings.nav.agent", keywordsKey: "settings.search.telegramBot", adminOnly: true },
  { href: "/settings/security", label: "settings.security.encryptionKey", page: "settings.nav.security", keywordsKey: "settings.search.encryption", adminOnly: true },
  { href: "/settings/security#sandbox-network", label: "settings.security.sandboxNet", page: "settings.nav.security", keywordsKey: "settings.search.sandboxNetwork", adminOnly: true },
  { href: "/settings/security#block-private-urls", label: "settings.security.blockPrivate", page: "settings.nav.security", keywordsKey: "settings.search.blockPrivate", adminOnly: true },
  { href: "/settings/security#host-folders", label: "settings.security.hostFolders", page: "settings.nav.security", keywordsKey: "settings.search.hostFolders", adminOnly: true },
  { href: "/settings/security#pc-folders", label: "settings.security.pcFolders", page: "settings.nav.security", keywordsKey: "settings.search.pcFolders", adminOnly: true },
  { href: "/settings/usage", label: "settings.usage.title", page: "settings.nav.usage", keywordsKey: "settings.search.usage", adminOnly: true },
  { href: "/settings/activity", label: "settings.activity.title", page: "settings.nav.activity", keywordsKey: "settings.search.activity", adminOnly: true },
  { href: "/settings/updates", label: "settings.updates.title", page: "settings.nav.updates", keywordsKey: "settings.search.updates", adminOnly: true },
];

/**
 * Rank entries against a typed query.
 *
 * Substring matching on purpose, not fuzzy: a settings list is ~28 short items,
 * and fuzzy matching on a set that small mostly produces confident nonsense (a
 * two-letter query like "mo" happily "matches" everything). A prefix hit outranks
 * a mid-word hit, and a hit in the visible label outranks one in the hidden
 * keywords — so typing "mem" puts the memory switch above the analytics page that
 * merely lists the word.
 */
export function searchSettings(
  entries: SettingsEntry[],
  query: string,
  resolve: (key: string) => string,
): SettingsEntry[] {
  // Every word must match SOMETHING, and each word is scored where it landed. This
  // is what makes a typed phrase work: "disable memory" finds the memory switch
  // (one word in its label, the other in its keywords), where matching the phrase
  // as one string would find nothing and look broken.
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const scored: { entry: SettingsEntry; score: number }[] = [];
  for (const entry of entries) {
    const label = resolve(entry.label).toLowerCase();
    const page = resolve(entry.page).toLowerCase();
    const keywords = (entry.keywordsKey ? resolve(entry.keywordsKey) : "").toLowerCase();

    let score = 0;
    for (const q of words) {
      let word = 0;
      if (label.startsWith(q)) word = 100;
      else if (label.includes(q)) word = 80;
      else if (page.startsWith(q)) word = 60;
      else if (keywords.split(/\s+/).some((w) => w.startsWith(q))) word = 40;
      else if (page.includes(q) || keywords.includes(q)) word = 20;

      if (word === 0) {
        score = 0;
        break;
      }
      score += word;
    }

    if (score > 0) scored.push({ entry, score });
  }

  // Stable within a score band, so equal matches keep the declared order (which
  // follows the sidebar) instead of shuffling as the query grows.
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}
