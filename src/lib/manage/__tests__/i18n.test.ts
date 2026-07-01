import { describe, it, expect } from "vitest";
import { manageT, loc, locValue, keyOf } from "../i18n";
import { buildRegistry } from "../controls";

const reg = buildRegistry();

describe("manage/i18n", () => {
  it("keyOf flattens control-id dots so they don't nest", () => {
    expect(keyOf("user.locale")).toBe("user_locale");
    expect(keyOf("org.sandbox_network")).toBe("org_sandbox_network");
  });

  it("falls back to the English literal when a key is untranslated", () => {
    const t = manageT("uk");
    expect(loc(t, "control.does_not_exist.title", "English default")).toBe("English default");
  });

  it("resolves a real Ukrainian translation when present", () => {
    const t = manageT("uk");
    expect(loc(t, "control.user_locale.title", "Interface language")).toBe("Мова інтерфейсу");
    expect(locValue(t, "org.sandbox_network", "bridge", "Network access")).toBe("З доступом до мережі");
    expect(locValue(t, "org.sandbox_enabled", "true", "Enabled")).toBe("Увімкнено"); // shared bool key
  });

  it("English locale falls back to the in-code literals (no separate en catalog to drift)", () => {
    const t = manageT("en");
    expect(loc(t, "control.user_locale.title", "Interface language")).toBe("Interface language");
    expect(locValue(t, "org.sandbox_network", "bridge", "Network access")).toBe("Network access");
  });

  it("ANTI-DIVERGENCE: every registered control has a Ukrainian title translation", () => {
    const t = manageT("uk");
    for (const c of reg.all()) {
      const localized = loc(t, `control.${keyOf(c.id)}.title`, c.title);
      // If a control were added without a uk key, this would equal the English
      // literal — catching the "changed one place, forgot the other" drift.
      expect(localized, `missing uk translation for control.${keyOf(c.id)}.title`).not.toBe(c.title);
    }
  });

  it("ANTI-DIVERGENCE: every collection has a Ukrainian title translation", () => {
    const t = manageT("uk");
    for (const coll of reg.collections()) {
      const localized = loc(t, `collection.${keyOf(coll.id)}`, coll.title);
      expect(localized, `missing uk translation for collection.${keyOf(coll.id)}`).not.toBe(coll.title);
    }
  });
});
