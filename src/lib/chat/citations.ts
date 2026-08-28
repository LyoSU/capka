import type { Root, RootContent } from "mdast";
import type { NumberedSource } from "@/lib/mcp/search-normalize";

/**
 * The client half of citations: resolve the `[N]` markers a reply carries
 * against the numbered sources this message's search results produced
 * (mcp/search-normalize.ts).
 *
 * A remark plugin rather than a string replace, for the same reason
 * workspace-path linking is one: it visits TEXT nodes only, so `[1]` inside
 * inline code or a fenced block is never rewritten, and an existing markdown
 * link keeps its label. The one deliberate property: a number that resolves
 * becomes a link; a number the model invented matches nothing and stays plain
 * text — visibly inert, never a fabricated link. A mixed group (`[1, 7]` with
 * 7 unknown) stays literal entirely, because rewriting half of it would
 * change what the user reads.
 */

/** `[3]` or `[1, 2]` — up to four digits (the allocation side stops minting at
 *  9999, see adapt.ts), comma groups allowed. Never matches footnote syntax
 *  (`[^1]`) or a markdown link label (those are link nodes). */
const CITE_RE = /\[(\d{1,4}(?:\s*,\s*\d{1,4})*)\]/g;

function chip(n: number, s: NumberedSource): RootContent {
  return {
    type: "link",
    url: s.url,
    title: s.title,
    children: [{ type: "text", value: String(n) }],
    // Flows through remark-rehype onto the anchor, where globals.css styles
    // `a[data-citation]` as a superscript pill — no component override needed.
    data: { hProperties: { "data-citation": "" } },
  };
}

export function makeRemarkCitations(sources: NumberedSource[]) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  // Hand-rolled recursion instead of unist-util-visit because the guard is
  // ANCESTRY, not parenthood: a marker inside `**bold**` inside a link has a
  // `strong` parent, and rewriting it there would nest an anchor inside an
  // anchor — invalid HTML the browser splits unpredictably. The `inLink` flag
  // survives arbitrarily deep formatting.
  const walk = (node: { children: RootContent[] }, inLink: boolean): void => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === "text" && !inLink) {
        const value = child.value;
        CITE_RE.lastIndex = 0;
        const out: RootContent[] = [];
        let last = 0;
        for (let m = CITE_RE.exec(value); m; m = CITE_RE.exec(value)) {
          const ns = m[1].split(",").map((p) => parseInt(p, 10));
          if (!ns.every((n) => byN.has(n))) continue; // mixed/unknown group stays literal
          if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
          for (const n of ns) out.push(chip(n, byN.get(n)!));
          last = m.index + m[0].length;
        }
        if (out.length === 0) continue;
        if (last < value.length) out.push({ type: "text", value: value.slice(last) });
        node.children.splice(i, 1, ...out);
        i += out.length - 1; // none of the inserted nodes is a text node to revisit
      } else if ("children" in child && Array.isArray(child.children)) {
        walk(child as { children: RootContent[] }, inLink || child.type === "link" || child.type === "linkReference");
      }
    }
  };
  return () => (tree: Root) => walk(tree, false);
}

/** The sources a reply actually cited, in number order — what the footer lists.
 *  A plain-regex scan over the raw markdown (so a `[1]` inside a code block
 *  counts too); footer over-inclusion is harmless, a broken chip is not, which
 *  is why the CHIP side runs on the mdast instead. */
export function citedSources(text: string, sources: NumberedSource[]): NumberedSource[] {
  if (!sources.length) return [];
  const byN = new Map(sources.map((s) => [s.n, s]));
  const out = new Map<number, NumberedSource>();
  CITE_RE.lastIndex = 0;
  for (const m of text.matchAll(CITE_RE)) {
    for (const part of m[1].split(",")) {
      const n = parseInt(part, 10);
      const s = byN.get(n);
      if (s) out.set(n, s);
    }
  }
  return [...out.values()].sort((a, b) => a.n - b.n);
}
