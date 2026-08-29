import { describe, it, expect } from "vitest";
import {
  recordsFromText, recordsFromValue, looksLikeMarkdown,
  fieldsFromValue, imagesFromValue, resourcesFromValue, readsAsTable,
} from "../record-list";

// A realistic text emission (searxng-style), but nothing in the parser knows
// that: the assertions below hold for ANY tool that emits the same SHAPE.
const SEARCH_TEXT = `Title: Bristol news — latest stories
Description: Fresh reporting from the region — events,
crime news and a great deal more.
URL: https://www.ukr.net/news/vinnytsya.html
Relevance Score: 1.000
Engines: google cse

Title: Everything from today — 20 minutes
Description: Independent regional news.
URL: https://vn.20minut.ua/
Relevance Score: 0.700
Engines: brave`;

describe("recordsFromText — the structural detector", () => {
  it("parses blank-line-separated Key: value blocks into records", () => {
    const records = recordsFromText(SEARCH_TEXT);
    expect(records).not.toBeNull();
    expect(records!.length).toBe(2);
    // Content, not just presence — a guard that passes on an empty list guards nothing.
    expect(records![0].fields[0]).toMatchObject({ label: "title", value: "Bristol news — latest stories" });
    expect(records![1].fields[0].value).toContain("20 minutes");
  });

  it("joins a hard-wrapped value back into one field instead of losing the tail", () => {
    const [first] = recordsFromText(SEARCH_TEXT)!;
    const desc = first.fields.find((f) => f.label === "description")!;
    expect(desc.value).toBe("Fresh reporting from the region — events, crime news and a great deal more.");
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
    expect(recordsFromText(SEARCH_TEXT + "\n\nTitle: cut off mid-")).not.toBeNull();
    expect(recordsFromText(SEARCH_TEXT + "\n\nTitle: cut off mid-")!.length).toBe(2);
    const middleBroken = SEARCH_TEXT.replace("Title: Everything from today", "plain text with no key\nSo: no");
    expect(recordsFromText(middleBroken)).toBeNull();
  });

  it("refuses prose, single blocks, and one-line entries — fail closed", () => {
    expect(recordsFromText("An ordinary sentence: with a colon inside it, and one more.")).toBeNull();
    // one block only — a lone record is indistinguishable from config chatter
    expect(recordsFromText("Title: one\nURL: https://a.example/")).toBeNull();
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
    const page = `[Report a story](https://www.facebook.com/example/)

* [News](https://example.test/category/news/)
* [Events](https://example.test/category/events/)
* [Listings](https://example.test/category/listings/)`;
    expect(looksLikeMarkdown(page)).toBe(true);
  });

  it("recognizes a structured document: repeated headings", () => {
    expect(looksLikeMarkdown("# Section\ntext\n\n## Subsection\nmore text")).toBe(true);
  });

  it("refuses plain text, bare URLs, and Key: value records — fail closed", () => {
    expect(looksLikeMarkdown("Just text with an https://a.example/ link in it.")).toBe(false);
    expect(looksLikeMarkdown(SEARCH_TEXT)).toBe(false);
    expect(looksLikeMarkdown("one * two * three")).toBe(false);
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

  // Scalar siblings are envelope chatter (success flags, totals), never the
  // payload — the walk toward the one container is what lets a stringified
  // API reply ({success: true, data: {web: [...]}}) render as the list it is.
  it("descends through scalar metadata to the one container, however wrapped", () => {
    expect(recordsFromValue({ results, total: 2 })!.length).toBe(2);
    expect(recordsFromValue({ success: true, data: { web: results } })!.length).toBe(2);
  });

  it("refuses two containers side by side — that structure has an opinion", () => {
    expect(recordsFromValue({ web: results, images: results })).toBeNull();
  });

  it("stops descending past the depth cap instead of spinning", () => {
    expect(recordsFromValue({ a: { b: { c: { d: results } } } })!.length).toBe(2);
    expect(recordsFromValue({ a: { b: { c: { d: { e: results } } } } })).toBeNull();
  });

  it("refuses short lists, scalar arrays, and nested arrays", () => {
    expect(recordsFromValue([{ a: 1 }])).toBeNull();
    expect(recordsFromValue(["a", "b"])).toBeNull();
    expect(recordsFromValue([[1], [2]])).toBeNull();
  });

  // The bug this rule exists for: two text blocks in the transport envelope are
  // the MESSAGE, and rendering them as a two-record list of {type, text} fields
  // would garble every multi-block MCP reply.
  it("never mistakes the MCP content envelope for data", () => {
    const envelope = {
      content: [
        { type: "text", text: "first block" },
        { type: "text", text: "second block" },
      ],
    };
    expect(recordsFromValue(envelope)).toBeNull();
    expect(recordsFromValue(envelope.content)).toBeNull();
  });
});

describe("fieldsFromValue — one typed object", () => {
  it("turns a single entity into params-style fields", () => {
    const fields = fieldsFromValue({ structuredContent: { temperature: 21, wind_speed: "5 m/s" } })!;
    expect(fields).toEqual([
      { label: "temperature", value: "21", mono: false },
      { label: "wind speed", value: "5 m/s", mono: false },
    ]);
  });

  it("sets transport fields aside and reads what remains", () => {
    const fields = fieldsFromValue({ content: [{ type: "text", text: "ok" }], isError: false, status: "green", count: 3 })!;
    expect(fields.map((f) => f.label).sort()).toEqual(["count", "status"]);
  });

  it("unwraps a pure single-key wrapper, but keeps scalar siblings as fields", () => {
    expect(fieldsFromValue({ data: { temperature: 21, humidity: 60 } })!.map((f) => f.label)).toEqual(["temperature", "humidity"]);
    // A scalar next to the container is a field of the entity as far as this
    // view can know — dropping it would hide data, so no descent happens here.
    expect(fieldsFromValue({ success: true, data: { temperature: 21 } })!.map((f) => f.label)).toEqual(["success", "data"]);
  });

  it("refuses arrays, scalars, and one-property objects — a sentence is not an entity", () => {
    expect(fieldsFromValue([{ a: 1 }, { a: 2 }])).toBeNull();
    expect(fieldsFromValue("text")).toBeNull();
    expect(fieldsFromValue({ message: "ok" })).toBeNull();
  });
});

describe("imagesFromValue / resourcesFromValue — the other MCP block types", () => {
  it("extracts image blocks as data URIs, capped at four", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ type: "image", data: `AAA${i}`, mimeType: "image/png" }));
    const images = imagesFromValue({ content: blocks })!;
    expect(images.length).toBe(4);
    expect(images[0].src).toBe("data:image/png;base64,AAA0");
  });

  it("extracts resource links with their names, and embedded resources by uri", () => {
    const refs = resourcesFromValue({
      content: [
        { type: "resource_link", uri: "https://api.example/reports/1", name: "August report", description: "PDF" },
        { type: "resource", resource: { uri: "file:///workspace/data.csv" } },
        { type: "text", text: "supporting prose" },
      ],
    })!;
    expect(refs).toEqual([
      { name: "August report", uri: "https://api.example/reports/1", description: "PDF" },
      { name: "file:///workspace/data.csv", uri: "file:///workspace/data.csv" },
    ]);
  });

  it("returns null when the envelope carries neither", () => {
    expect(imagesFromValue({ content: [{ type: "text", text: "x" }] })).toBeNull();
    expect(resourcesFromValue({ content: [{ type: "text", text: "x" }] })).toBeNull();
    expect(imagesFromValue("text")).toBeNull();
  });
});

describe("readsAsTable — cards vs table by regularity", () => {
  const row = (n: number) => ({
    fields: [
      { label: "name", value: `item ${n}`, mono: false },
      { label: "qty", value: String(n), mono: false },
    ],
  });

  it("chooses a table for three-plus homogeneous short records", () => {
    expect(readsAsTable([row(1), row(2), row(3)])).toBe(true);
  });

  it("keeps cards for two records, ragged keys, or a long value", () => {
    expect(readsAsTable([row(1), row(2)])).toBe(false);
    const ragged = [row(1), row(2), { fields: [{ label: "other", value: "x", mono: false }, { label: "qty", value: "9", mono: false }] }];
    expect(readsAsTable(ragged)).toBe(false);
    const long = [row(1), row(2), { fields: [{ label: "name", value: "y".repeat(80), mono: false }, { label: "qty", value: "9", mono: false }] }];
    expect(readsAsTable(long)).toBe(false);
  });
});
