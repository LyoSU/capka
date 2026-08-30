import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE PLACE DECIDES WHETHER A STORED STATEMENT IS LEGIBLE.
 *
 * This is a source-text test, which is unusual here and deliberate. The rule it guards has
 * now been broken three times in this feature by the same mechanism — a rule held at one
 * entrance while a newly-added second walks past it — and none of the three was reachable
 * by any other test in this repo: vitest runs `environment: "node"` with no React
 * renderer, so nothing here can assert what a component put on screen.
 *
 * Two of the three breaches were shipped in the SAME commit that introduced the rule:
 * `Amendment D`'s conflict line printed a contested head's words while blurring on the
 * candidate's flag, and "Edit wording" swapped the row for a plain textarea holding the
 * raw text. Both authors of those lines knew the rule. Knowing it is not what stops this.
 *
 * The structural half of the fix is `StatementView` (`memory-page.ts`): the text is not a
 * `string` on the wire, so it cannot be dropped into JSX or interpolated into a translated
 * sentence without failing `tsc`, and the only consumer of the shape is `Statement`. That
 * catches the accidental bypass. It does NOT catch a deliberate one — `value.text` is
 * still structurally reachable, and `memory-review.tsx` reaches for it once on purpose, to
 * seed the edit textarea after the person has revealed the fact.
 *
 * So this test covers what the type cannot: that `sensitive` is READ in exactly one module.
 * A second reader is a second copy of the rule, and a second copy is how all three
 * happened.
 */

const ROOTS = ["src/components/settings", "src/app/(dashboard)/settings/memory"];

/** The module that owns `Statement`, `useReveal` and `SensitiveEditNote` — the three
 *  things allowed to know a statement's sensitivity, all of them rendering decisions. */
const OWNER = "src/components/settings/memory-topics.tsx";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Lines that mention the field for real, ignoring prose. A comment explaining the rule is
 *  not a second implementation of it, and the alternative — banning the word — would push
 *  the reasoning out of the files that need it most. */
const READS_SENSITIVE = /(?:\.sensitive\b|\bsensitive\s*[:,)]|\bsensitive\s*&&|!\s*\w*\.?sensitive\b)/;

const codeLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("*") && !l.startsWith("//") && !l.startsWith("/*"));

describe("a statement's legibility is decided in one place", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r));

  it("finds the memory surface's files at all", () => {
    // The control. A test that scans a mistyped directory finds no violations and passes
    // for the wrong reason — which, on a guard whose whole job is to fail later, would be
    // indistinguishable from working.
    expect(files).toContain(OWNER);
    expect(files).toContain("src/components/settings/memory-review.tsx");
  });

  it("reads `sensitive` in exactly one module", () => {
    const readers = files.filter((f) => codeLines(readFileSync(f, "utf8")).some((l) => READS_SENSITIVE.test(l)));
    expect(readers).toEqual([OWNER]);
  });

  it("keeps the reveal control out of every other file", () => {
    // `blur` and `aria-hidden`-on-text are the rule's implementation, not its statement.
    // A second copy of them somewhere else would satisfy the check above (it might never
    // name `sensitive`, taking a boolean prop instead) while re-creating exactly the
    // divergence this exists to stop.
    const blurring = files.filter((f) => /blur-\[/.test(readFileSync(f, "utf8")));
    expect(blurring).toEqual([OWNER]);
  });

  it("unwraps a statement's raw text at exactly one site outside the owner", () => {
    // `sensitive` is only half of it. The conflict line did not read the flag either — it
    // took the WORDS and interpolated them into a sentence, and that is the same bypass
    // with the same result. `StatementView` makes the unwrap visible (`.statement.text`)
    // rather than impossible: it must stay reachable, because the edit box has to be
    // seeded with the words, and that one site is gated on the reveal below.
    //
    // An equality assertion, not a ceiling: a second unwrap has to be argued for here,
    // in this file, next to the reason there is one.
    const counted = Object.fromEntries(
      files
        .map((f) => [f, (readFileSync(f, "utf8").match(/\.statement\.text\b/g) ?? []).length] as const)
        .filter(([, n]) => n > 0),
    );
    expect(counted).toEqual({ "src/components/settings/memory-review.tsx": 1 });
  });

  it("gates the editor on the reveal, not on a flag of its own", () => {
    // A source-text assertion, and deliberately so: this repo's vitest runs
    // `environment: "node"` with no renderer, so "the button is disabled" is not
    // something any test here can observe. The alternative to a brittle assertion is no
    // assertion, and this is the entrance where one click on a button labelled "Edit
    // wording" put a sensitive statement on screen with nothing having asked.
    const review = readFileSync("src/components/settings/memory-review.tsx", "utf8");
    expect(review).toMatch(/disabled=\{[^}]*!reveal\.shown[^}]*\}/);
  });
});
