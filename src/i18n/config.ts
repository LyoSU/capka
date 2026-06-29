/**
 * Single source of truth for the supported locales.
 *
 * Capka runs without locale-based URL routing: there is no `/[locale]` segment
 * and no middleware. The active locale is resolved per request (see `locale.ts`)
 * and English is the default — message keys in the codebase are English.
 */
export const locales = ["en", "uk"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/** Human-readable names for the language switcher (in their own language). */
export const localeNames: Record<Locale, string> = {
  en: "English",
  uk: "Українська",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/**
 * Pick the best supported locale from an `Accept-Language` header.
 * Returns `null` when nothing matches, so the caller can fall back.
 *
 * Two locales don't justify a parsing dependency: split on `,`, honour the
 * `;q=` weights, and match on the primary subtag (`uk-UA` → `uk`).
 */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const weight = q ? Number.parseFloat(q.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isNaN(weight) ? 0 : weight };
    })
    .sort((a, b) => b.weight - a.weight);

  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return null;
}
