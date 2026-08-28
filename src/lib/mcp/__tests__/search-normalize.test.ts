import { describe, it, expect } from "vitest";
import { extractSearchRecords, sourcesFromOutput, sourcesModelText } from "../search-normalize";

const text = (t: string) => ({ type: "text", text: t });

describe("extractSearchRecords — labeled text (Tavily/Exa shape)", () => {
  it("parses Title:/URL:/Content: records and keeps the answer as preamble", () => {
    const result = {
      content: [text(
        "Kyiv is the capital of Ukraine.\n\n" +
        "Title: Kyiv - Wikipedia\nURL: https://en.wikipedia.org/wiki/Kyiv\nContent: Kyiv is the capital and most populous city.\n\n" +
        "Title: Kyiv city guide\nURL: https://example.com/kyiv\nContent: What to see in Kyiv.",
      )],
    };
    const found = extractSearchRecords(result)!;
    expect(found.records).toHaveLength(2);
    expect(found.records[0]).toMatchObject({ title: "Kyiv - Wikipedia", url: "https://en.wikipedia.org/wiki/Kyiv" });
    expect(found.records[0].snippet).toContain("capital");
    expect(found.preamble).toContain("Kyiv is the capital");
  });

  it("parses Exa-style records with --- separators and Highlights", () => {
    const body = [
      "Title: First\nURL: https://a.example/1\nPublished: 2026-01-01\nHighlights: one two",
      "Title: Second\nURL: https://b.example/2\nHighlights: three",
    ].join("\n\n---\n\n");
    const found = extractSearchRecords({ content: [text(body)] })!;
    expect(found.records.map((r) => r.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
    expect(found.records[0].snippet).toBe("one two");
  });

  it("rejects a single record — a fetched page is not a search", () => {
    expect(extractSearchRecords({ content: [text("Title: Only\nURL: https://a.example/1")] })).toBeNull();
  });

  it("rejects prose and markdown pages", () => {
    expect(extractSearchRecords({ content: [text("# Heading\n\nSome scraped article with a link https://a.example inside.")] })).toBeNull();
  });
});

describe("extractSearchRecords — JSON shapes", () => {
  it("finds records under a nested search wrapper key ({web: {results}})", () => {
    const payload = { web: { results: [
      { url: "https://a.example/1", title: "A" },
      { url: "https://b.example/2", title: "B" },
    ] } };
    const found = extractSearchRecords({ content: [text(JSON.stringify(payload))] })!;
    expect(found.records.map((r) => r.title)).toEqual(["A", "B"]);
  });

  it("takes structuredContent ahead of text", () => {
    const found = extractSearchRecords({
      structuredContent: { results: [
        { url: "https://a.example/1", title: "A", snippet: "sa" },
        { url: "https://b.example/2", title: "B", snippet: "sb" },
      ] },
      content: [text("irrelevant")],
    })!;
    expect(found.records).toHaveLength(2);
  });

  it("accepts a generic data-array only when entries read as hits (url+title+snippet)", () => {
    const hits = { success: true, data: [
      { url: "https://a.example/1", title: "A", description: "da" },
      { url: "https://b.example/2", title: "B", description: "db" },
    ] };
    expect(extractSearchRecords({ content: [text(JSON.stringify(hits))] })!.records).toHaveLength(2);
    // DB-ish rows with a url column but no snippet must stay a table, not sources.
    const rows = { data: [
      { url: "https://a.example/1", name: "row one" },
      { url: "https://b.example/2", name: "row two" },
    ] };
    expect(extractSearchRecords({ content: [text(JSON.stringify(rows))] })).toBeNull();
  });

  it("parses one JSON object per text block (Brave shape)", () => {
    const found = extractSearchRecords({ content: [
      text(JSON.stringify({ url: "https://a.example/1", title: "A", description: "da" })),
      text(JSON.stringify({ url: "https://b.example/2", title: "B", description: "db" })),
    ] })!;
    expect(found.records.map((r) => r.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  it("drops entries without a real http(s) URL and dedupes by URL", () => {
    const payload = { results: [
      { url: "https://a.example/1", title: "A" },
      { url: "https://a.example/1", title: "A again" },
      { url: "ftp://nope.example", title: "ftp" },
      { url: "https://b.example/2", title: "B" },
    ] };
    const found = extractSearchRecords({ content: [text(JSON.stringify(payload))] })!;
    expect(found.records.map((r) => r.title)).toEqual(["A", "B"]);
  });
});

describe("sourcesFromOutput", () => {
  it("reads back what the adapter attached, ignoring malformed entries", () => {
    const out = { content: [], capkaSources: [
      { n: 1, title: "A", url: "https://a.example" },
      { bogus: true },
    ] };
    expect(sourcesFromOutput(out)).toEqual([{ n: 1, title: "A", url: "https://a.example" }]);
    expect(sourcesFromOutput({ content: [] })).toBeNull();
    expect(sourcesFromOutput("text")).toBeNull();
  });
});

describe("sourcesModelText", () => {
  it("renders [N] lines with the citing instruction, preamble first", () => {
    const s = sourcesModelText(
      [{ n: 3, title: "A", url: "https://a.example", snippet: "sn" }],
      "The short answer.",
    );
    expect(s.startsWith("The short answer.")).toBe(true);
    expect(s).toContain("cite it inline as [N]");
    expect(s).toContain("[3] A — https://a.example\nsn");
  });
});
