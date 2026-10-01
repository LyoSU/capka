import { describe, it, expect } from "vitest";
import { intakeHash, parseIntakeHash, shareText } from "@/lib/chat/intake";

describe("shareText", () => {
  it("joins title, text and url without repeating a link already in the text", () => {
    expect(shareText({ title: "Quarterly report", text: "Look at this https://x.test/r", url: "https://x.test/r" })).toBe(
      "Quarterly report\nLook at this https://x.test/r",
    );
  });

  it("drops a title that is only the url, and empty fields", () => {
    expect(shareText({ title: "https://x.test/r", text: "", url: "https://x.test/r" })).toBe("https://x.test/r");
    expect(shareText({ title: null, text: null, url: null })).toBe("");
  });
});

describe("intake hash", () => {
  it("round-trips refs (non-ASCII names, spaces) and text", () => {
    const refs = [
      { name: "Zpráva čtvrtletí.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { name: "data (1).csv", type: "text/csv" },
    ];
    expect(parseIntakeHash(intakeHash(refs, "Line one\n#two"))).toEqual({ refs, text: "Line one\n#two" });
  });

  it("ignores any other fragment, garbage, and malformed refs", () => {
    expect(parseIntakeHash("#message-123")).toBeNull();
    expect(parseIntakeHash("#intake=%7Bnot-json")).toBeNull();
    const junk = { refs: [1, { name: "" , type: "" }, { name: "ok.txt", type: "text/plain", extra: true }, { name: "x" }], text: 5 };
    expect(parseIntakeHash(`#intake=${encodeURIComponent(JSON.stringify(junk))}`)).toEqual({
      refs: [{ name: "ok.txt", type: "text/plain" }],
      text: "",
    });
  });
});
