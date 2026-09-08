import { describe, it, expect } from "vitest";
import type { Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { remarkDollarMathGuard } from "../dollar-math";

/**
 * Trees shaped like the ones remark-math actually produces, measured against
 * remark-math 6 with `singleDollarTextMath: true`:
 *   - `value` is TRIMMED ("$ x + y $" -> "x + y"), so the guard cannot read the
 *     delimiters off it and has to slice the source instead;
 *   - `position` spans the delimiters themselves ("$5 and $"), so `end.offset`
 *     is the index of the character right after the closing "$".
 */
function tree(src: string, raw: string): Root {
  const start = src.indexOf(raw);
  if (start < 0) throw new Error(`fixture bug: ${raw} not in ${src}`);
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: src.slice(0, start) },
          {
            type: "inlineMath",
            value: raw.slice(1, -1).trim(),
            position: { start: { offset: start } as never, end: { offset: start + raw.length } as never },
          },
          { type: "text", value: src.slice(start + raw.length) },
        ],
      },
    ],
  } as unknown as Root;
}

function run(src: string, raw: string) {
  const root = tree(src, raw);
  remarkDollarMathGuard()(root, { toString: () => src });
  const kids = (root.children[0] as { children: { type: string; value?: string }[] }).children;
  return kids[1];
}

describe("remarkDollarMathGuard — which single-dollar spans are money, not math", () => {
  it("demotes a price pair, which remark-math reads as one span (the reported hazard)", () => {
    // "costs $5 and $10 each" parses as inlineMath("5 and "), swallowing both signs.
    const node = run("costs $5 and $10 each", "$5 and $");
    expect(node.type).toBe("text");
    expect(node.value).toBe("$5 and $");
  });

  it("demotes a price range, where nothing but the trailing digit gives it away", () => {
    // "$5-$" has no whitespace to catch it; the "1" of "$10" does.
    const node = run("costs $5-$10 per kg", "$5-$");
    expect(node.type).toBe("text");
    expect(node.value).toBe("$5-$");
  });

  it("keeps a bare variable, the shortest thing models write as math", () => {
    expect(run("the variable $x$ in the formula", "$x$").type).toBe("inlineMath");
  });

  it("keeps the formula from the bug report", () => {
    const src = String.raw`chain: $1{,}0 \times 0{,}5 = \mathbf{31{,}5\%}$ total`;
    expect(run(src, String.raw`$1{,}0 \times 0{,}5 = \mathbf{31{,}5\%}$`).type).toBe("inlineMath");
  });

  it("demotes padded dollars with no LaTeX in them, as Pandoc's rule does", () => {
    expect(run("paid $ 100 and $ 200 today", "$ 100 and $").type).toBe("text");
  });

  it("keeps padded dollars once a backslash proves it is LaTeX", () => {
    expect(run(String.raw`area $ \frac{a}{b} $ here`, String.raw`$ \frac{a}{b} $`).type).toBe("inlineMath");
  });

  it("leaves double-dollar spans alone — those never had the money ambiguity", () => {
    expect(run("inline $$a2$$ block", "$$a2$$").type).toBe("inlineMath");
  });
});

/**
 * The same rules through the real parser. This half is what proves the guard is
 * WIRED, not merely correct: it reads the delimiters off the source, which only
 * reaches it as the second argument to `run`/`runSync` — exactly how Streamdown
 * calls it (`t.runSync(t.parse(src), src)`). Drop that argument and every
 * assertion below flips while the fixture tests above stay green.
 *
 * remark-parse/remark-math are not direct dependencies; they arrive under
 * streamdown and @streamdown/math, which are. Nothing else can exercise this.
 */
const pipeline = unified().use(remarkParse).use(remarkMath, { singleDollarTextMath: true }).use(remarkDollarMathGuard);

async function formulas(src: string): Promise<string[]> {
  const out: string[] = [];
  const walk = (n: { type: string; value?: string; children?: unknown[] }) => {
    if (n.type === "inlineMath" || n.type === "math") out.push(n.value!);
    for (const c of (n.children ?? []) as { type: string; value?: string; children?: unknown[] }[]) walk(c);
  };
  walk((await pipeline.run(pipeline.parse(src), src)) as never);
  return out;
}

describe("single-dollar math end to end", () => {
  it("typesets the formula from the bug report", async () => {
    expect(await formulas(String.raw`chain: $1{,}0 \times 0{,}5 = \mathbf{31{,}5\%}$`)).toEqual([
      String.raw`1{,}0 \times 0{,}5 = \mathbf{31{,}5\%}`,
    ]);
  });

  it("reads no formula out of prices", async () => {
    expect(await formulas("costs $5 and $10 each")).toEqual([]);
    expect(await formulas("costs $5-$10 per kg")).toEqual([]);
    expect(await formulas("Price $5 and $7.")).toEqual([]);
    expect(await formulas("budget $5 million")).toEqual([]);
  });

  it("still typesets variables and display math, and never enters a code span", async () => {
    expect(await formulas("the variable $x$ here")).toEqual(["x"]);
    expect(await formulas("$$a^2+b^2=c^2$$")).toEqual(["a^2+b^2=c^2"]);
    expect(await formulas("run `echo $HOME` now")).toEqual([]);
  });
});
