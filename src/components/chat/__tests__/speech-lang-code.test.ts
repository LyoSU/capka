import { describe, expect, it } from "vitest";
import { speechLangCode } from "@/components/chat/use-dictation";

describe("speechLangCode", () => {
  it("takes three letters of the endonym, uppercased", () => {
    expect(speechLangCode("uk-UA")).toBe(String.fromCodePoint(0x423, 0x41a, 0x420));
    expect(speechLangCode("en-US")).toBe("ENG");
    expect(speechLangCode("pl")).toBe("POL");
    expect(speechLangCode("de-DE")).toBe("DEU");
    expect(speechLangCode("fr-FR")).toBe("FRA");
    expect(speechLangCode("es-ES")).toBe("ESP");
  });
  it("never yields a two-letter code for a known language", () => {
    for (const tag of ["uk", "en", "pl", "de", "fr", "es", "it"]) expect(speechLangCode(tag)).toHaveLength(3);
  });
  it("falls back to the subtag for a malformed tag", () => {
    expect(speechLangCode("zz")).toBe("ZZ");
    expect(() => speechLangCode("!!")).not.toThrow();
  });
});
