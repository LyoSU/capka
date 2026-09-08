import type { Root } from "mdast";

/**
 * The money half of single-dollar math.
 *
 * Streamdown's math plugin ships with `singleDollarTextMath: false`, so a reply
 * written as `$x = 1$` rendered as raw LaTeX. Turning it on is what makes those
 * formulas typeset — and it also hands remark-math every price in the
 * transcript: `costs $5 and $10 each` parses as ONE inline formula whose body is
 * `5 and `, so both dollar signs vanish and the sentence silently changes
 * meaning. For an audience discussing invoices that is worse than an untypeset
 * formula, which is why the plugin is enabled WITH this guard rather than alone.
 *
 * The rule is Pandoc's, which has arbitrated exactly this ambiguity for years:
 * the opening `$` must be followed by a non-space, the closing `$` preceded by
 * one, and the closing `$` must not be followed by a digit (that last clause is
 * the only thing separating `$5-$10` from real math — it carries no whitespace
 * to give it away). Anything holding a backslash, `^` or `_` is a TeX command
 * and skips the test outright: prices never contain one, and `$ \frac{a}{b} $`
 * is math however it is padded.
 *
 * A tree transformer, not a string pre-pass, for the same reason citations.ts is
 * one: `$HOME` inside a code span is an `inlineCode` node that remark-math never
 * touched, and escaping dollars in the raw text would corrupt it.
 */

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Is this `$…$` span a price rather than a formula? `start`/`end` bracket the
 *  delimiters themselves — the node's own `value` is trimmed by remark-math, so
 *  it cannot answer the whitespace half of the rule. */
function isMoney(src: string, start: number, end: number): boolean {
  const raw = src.slice(start, end);
  if (!raw.startsWith("$") || raw.startsWith("$$")) return false; // `$$…$$` was never ambiguous
  const inner = raw.slice(1, -1);
  if (/[\\^_]/.test(inner)) return false; // a TeX command, subscript or superscript
  return /^\s|\s$/.test(inner) || /\d/.test(src.charAt(end));
}

/** A NAMED attacher, like remarkCitations: Streamdown caches its processor by
 *  plugin name, and an anonymous one collides with every other. */
export function remarkDollarMathGuard() {
  return (tree: Root, file: { toString(): string }) => {
    const src = String(file);
    const walk = (node: MdNode): void => {
      const kids = node.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.type === "inlineMath") {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          // Without positions there is nothing to judge; leave it as math.
          if (start != null && end != null && isMoney(src, start, end)) {
            kids[i] = { type: "text", value: src.slice(start, end) };
          }
        } else {
          walk(child);
        }
      }
    };
    walk(tree as unknown as MdNode);
  };
}
