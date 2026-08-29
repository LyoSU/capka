import { createTranslator } from "next-intl";
import { toLocale } from "@/lib/i18n/translator";
import type { Locale } from "@/i18n/config";
import en from "../../../messages/en.json";
import uk from "../../../messages/uk.json";

/**
 * The ONE place manage strings are localized. Anti-divergence design:
 *  - English lives in the code (control literals) as the single source of truth
 *    AND the fallback — so English can never drift out of a separate file.
 *  - `messages/<locale>.json` under the "manage" namespace holds ONLY additive
 *    translations, keyed by `keyOf(id)`. A missing key silently falls back to the
 *    English literal — forgetting a translation degrades gracefully, never breaks.
 *  - Keys are DERIVED from the control/value id here, so renaming an id can't
 *    leave a stale hand-written key behind.
 */
const MESSAGES: Record<Locale, Record<string, unknown>> = { en, uk };
// A sentinel next-intl returns for an untranslated key, distinct from any real
// translation. Written as an escape (NOT a raw NUL byte, which would make this
// file read as binary to git diff/blame and choke NUL-averse tooling).
const MISSING = "\x00missing";

export type ManageT = (key: string, values?: Record<string, string | number>) => string;

/** Build a manage-scoped translator. Missing keys resolve to a sentinel (not a
 *  noisy thrown/logged error) so `loc` can fall back to the English literal. */
export function manageT(locale?: string): ManageT {
  const l = toLocale(locale);
  return createTranslator({
    locale: l,
    messages: MESSAGES[l],
    namespace: "manage",
    onError: () => {},
    getMessageFallback: () => MISSING,
  }) as unknown as ManageT;
}

/** id → key segment. Control ids contain dots ("user.locale"); next-intl treats
 *  dots as nesting, so flatten them. The single definition of this mapping. */
export function keyOf(id: string): string {
  return id.replace(/\./g, "_");
}

/** Localized string for `key`, or the English `fallback` if untranslated. */
export function loc(t: ManageT, key: string, fallback: string, values?: Record<string, string | number>): string {
  const v = t(key, values);
  return v === MISSING || v === "" ? fallback : v;
}

/** Localized display of a raw setting value (e.g. "bridge" → "With network access").
 *  Tries a per-control key, then a shared key for booleans, then the English
 *  fallback (the control's own format/raw). */
export function locValue(t: ManageT, controlId: string, raw: string, fallback: string): string {
  const perControl = t(`value.${keyOf(controlId)}.${raw}`);
  if (perControl !== MISSING && perControl !== "") return perControl;
  if (raw === "true" || raw === "false") {
    const b = t(`value.bool.${raw}`);
    if (b !== MISSING && b !== "") return b;
  }
  return fallback;
}
