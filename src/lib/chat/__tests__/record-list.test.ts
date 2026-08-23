import { describe, it, expect } from "vitest";
import { recordsFromText, recordsFromValue, looksLikeMarkdown } from "../record-list";

// A realistic text emission (searxng-style), but nothing in the parser knows
// that: the assertions below hold for ANY tool that emits the same SHAPE.
const SEARCH_TEXT = `Title: Новини Вінниці — останні події
Description: Свіжі новини на UKR.NET — події,
кримінальні новини і багато іншого.
URL: https://www.ukr.net/news/vinnytsya.html
Relevance Score: 1.000
Engines: google cse

Title: Всі новини за сьогодні — 20 хвилин
Description: Незалежні новини регіону.
URL: https://vn.20minut.ua/
Relevance Score: 0.700
Engines: brave`;

describe("recordsFromText — the structural detector", () => {
  it("parses blank-line-separated Key: value blocks into records", () => {
    const records = recordsFromText(SEARCH_TEXT);
    expect(records).not.toBeNull();
    expect(records!.length).toBe(2);
    // Content, not just presence — a guard that passes on an empty list guards nothing.
    expect(records![0].fields[0]).toMatchObject({ label: "title", value: "Новини Вінниці — останні події" });
    expect(records![1].fields[0].value).toContain("20 хвилин");
  });

  it("joins a hard-wrapped value back into one field instead of losing the tail", () => {
    const [first] = recordsFromText(SEARCH_TEXT)!;
    const desc = first.fields.find((f) => f.label === "description")!;
    expect(desc.value).toBe("Свіжі новини на UKR.NET — події, кримінальні новини і багато іншого.");
  });

  it("marks a bare URL value so the UI can link it, and humanizes multi-word keys", () => {
    const [first] = recordsFromText(SEARCH_TEXT)!;
    expect(first.fields.find((f) => f.label === "url")).toMatchObject({
      value: "https://www.ukr.net/news/vinnytsya.html",
      url: true,
    });
    expect(first.fields.some((f) => f.label === "relevance score")).toBe(true);
  });

  // The server-side output clamp cuts mid-record; the stub must not kill the
  // whole rendering once a real list has already formed.
  it("drops only a truncated FINAL block, never a broken middle one", () => {
    expect(recordsFromText(SEARCH_TEXT + "\n\nTitle: обірваний за")).not.toBeNull();
    expect(recordsFromText(SEARCH_TEXT + "\n\nTitle: обірваний за")!.length).toBe(2);
    const middleBroken = SEARCH_TEXT.replace("Title: Всі новини", "просто текст без ключа\nТаке: ні");
    expect(recordsFromText(middleBroken)).toBeNull();
  });

  it("refuses prose, single blocks, and one-line entries — fail closed", () => {
    expect(recordsFromText("Звичайне речення: з двокрапкою всередині, і ще одне.")).toBeNull();
    // one block only — a lone record is indistinguishable from config chatter
    expect(recordsFromText("Title: один\nURL: https://a.example/")).toBeNull();
    // one-line entries (name: version listings)
    expect(recordsFromText("left-pad: 1.0.0\n\nlodash: 4.17.21")).toBeNull();
  });

  it("refuses blocks that do not open with the same lead key", () => {
    const mixed = "Title: a\nURL: https://a.example/\n\nName: b\nURL: https://b.example/";
    expect(recordsFromText(mixed)).toBeNull();
  });

  it("refuses git-log-shaped output, whose first line carries no key", () => {
    const log = "commit abc123\nAuthor: x\nDate: y\n\ncommit def456\nAuthor: z\nDate: w";
    expect(recordsFromText(log)).toBeNull();
  });
});

describe("looksLikeMarkdown — the density detector", () => {
  it("recognizes a scraped page: several markdown links", () => {
    const page = `[Повідомити новину](https://www.facebook.com/vezha.ua/)

* [Новини](https://vezha.ua/category/novini/)
* [Події](https://vezha.ua/category/podii/)
* [Анонси](https://vezha.ua/category/anonsy/)`;
    expect(looksLikeMarkdown(page)).toBe(true);
  });

  it("recognizes a structured document: repeated headings", () => {
    expect(looksLikeMarkdown("# Розділ\nтекст\n\n## Підрозділ\nще текст")).toBe(true);
  });

  it("refuses plain text, bare URLs, and Key: value records — fail closed", () => {
    expect(looksLikeMarkdown("Просто текст із https://a.example/ посиланням.")).toBe(false);
    expect(looksLikeMarkdown(SEARCH_TEXT)).toBe(false);
    expect(looksLikeMarkdown("один * два * три")).toBe(false);
  });
});

describe("recordsFromValue — the MCP-standard path", () => {
  const results = [
    { title: "A", url: "https://a.example/", score: 1 },
    { title: "B", url: "https://b.example/", score: 0.5 },
  ];

  it("accepts a bare array of plain objects", () => {
    const records = recordsFromValue(results)!;
    expect(records.length).toBe(2);
    expect(records[0].fields[0]).toMatchObject({ label: "title", value: "A" });
    expect(records[0].fields[1]).toMatchObject({ value: "https://a.example/", url: true });
  });

  it("unwraps structuredContent, and a single wrapper key around the array", () => {
    expect(recordsFromValue({ structuredContent: { results } })!.length).toBe(2);
    expect(recordsFromValue({ results })!.length).toBe(2);
  });

  it("refuses a wrapper with two properties — that structure has an opinion", () => {
    expect(recordsFromValue({ results, total: 2 })).toBeNull();
  });

  it("refuses short lists, scalar arrays, and nested arrays", () => {
    expect(recordsFromValue([{ a: 1 }])).toBeNull();
    expect(recordsFromValue(["a", "b"])).toBeNull();
    expect(recordsFromValue([[1], [2]])).toBeNull();
  });
});
