import { describe, it, expect } from "vitest";
import type { Root } from "mdast";
import { makeRemarkCitations, citedSources } from "../citations";

const SOURCES = [
  { n: 1, title: "A", url: "https://a.example/1" },
  { n: 2, title: "B", url: "https://b.example/2" },
  { n: 3, title: "C", url: "https://c.example/3" },
];

const para = (children: unknown[]) =>
  ({ type: "root", children: [{ type: "paragraph", children }] }) as unknown as Root;

function run(tree: Root): Root {
  makeRemarkCitations(SOURCES)()(tree);
  return tree;
}

describe("makeRemarkCitations", () => {
  it("turns a resolvable [N] into a link chip and leaves surrounding text intact", () => {
    const tree = run(para([{ type: "text", value: "Kyiv is the capital [1] of Ukraine." }]));
    const children = (tree.children[0] as { children: { type: string; url?: string; title?: string; data?: { hProperties?: Record<string, unknown> }; children?: { value: string }[]; value?: string }[] }).children;
    expect(children.map((c) => c.type)).toEqual(["text", "link", "text"]);
    expect(children[1].url).toBe("https://a.example/1");
    expect(children[1].title).toBe("A");
    expect(children[1].data?.hProperties).toHaveProperty("data-citation");
    expect(children[1].children![0].value).toBe("1");
  });

  it("splits a comma group [2, 3] into one chip per source", () => {
    const tree = run(para([{ type: "text", value: "See [2, 3]." }]));
    const children = (tree.children[0] as { children: { type: string; url?: string }[] }).children;
    expect(children.filter((c) => c.type === "link").map((c) => c.url)).toEqual(["https://b.example/2", "https://c.example/3"]);
  });

  it("leaves an invented number as plain text — visibly inert, never a fabricated link", () => {
    const tree = run(para([{ type: "text", value: "Bogus [9] claim." }]));
    const children = (tree.children[0] as { children: { type: string; value?: string }[] }).children;
    expect(children).toHaveLength(1);
    expect(children[0].value).toBe("Bogus [9] claim.");
  });

  it("leaves a mixed group entirely literal — rewriting half would change what the user reads", () => {
    const tree = run(para([{ type: "text", value: "Mixed [1, 9] group." }]));
    const children = (tree.children[0] as { children: { type: string }[] }).children;
    expect(children.map((c) => c.type)).toEqual(["text"]);
  });

  it("never rewrites the caption of an existing link", () => {
    const tree = para([{ type: "link", url: "https://x.example", children: [{ type: "text", value: "[1]" }] }]);
    run(tree);
    const link = (tree.children[0] as { children: { type: string; children: { type: string; value: string }[] }[] }).children[0];
    expect(link.children[0].value).toBe("[1]");
  });
});

describe("citedSources", () => {
  it("returns only the cited subset, deduped, in number order", () => {
    expect(citedSources("uses [2] then [1] and [2] again, plus bogus [9]", SOURCES).map((s) => s.n)).toEqual([1, 2]);
  });
  it("is empty with no sources or no markers", () => {
    expect(citedSources("[1]", [])).toEqual([]);
    expect(citedSources("no markers here", SOURCES)).toEqual([]);
  });
});
