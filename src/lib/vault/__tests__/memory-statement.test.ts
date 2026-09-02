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
 * sentence without failing `tsc`, and the only consumers of the shape are `Statement` and
 * `TrustBadge`. That catches the accidental bypass. It does NOT catch a deliberate one —
 * `value.text` is still structurally reachable, which is why the count below is an
 * equality and why it is currently EMPTY.
 *
 * So this test covers what the type cannot: that `sensitive` is READ in exactly one module.
 * A second reader is a second copy of the rule, and a second copy is how all three
 * happened.
 */

const ROOTS = ["src/components/settings", "src/app/(dashboard)/settings/memory"];

/** The module that owns `Statement`, `useReveal` and `TrustBadge` — the three things
 *  allowed to know a statement's sensitivity, all of them rendering decisions.
 *
 *  `TrustBadge` arrived with the trust tag and takes the whole `StatementView` rather than
 *  a `sensitive` boolean, for exactly the reason this file exists: a caller computing
 *  `sensitive={x.statement.sensitive}` to pick a chip would have been the second reader,
 *  and every breach in the paragraph above was a second reader. `SensitiveEditNote` left
 *  with the archive's edit control (§11.8) — see `memory-topics.tsx` for where its
 *  argument went. */
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

  it("unwraps a statement's raw text NOWHERE outside the owner", () => {
    // `sensitive` is only half of it. The conflict line did not read the flag either — it
    // took the WORDS and interpolated them into a sentence, and that is the same bypass
    // with the same result. `StatementView` makes the unwrap visible (`.statement.text`)
    // rather than impossible.
    //
    // IT WAS ONE, AND IT IS NOW NONE. The single sanctioned unwrap seeded the archive's
    // edit textarea with the words, gated on the reveal; the archive is read-only since
    // §11.8 removed the review queue, so the last consumer of a raw statement outside
    // `Statement` is gone. An equality assertion, not a ceiling: a new unwrap has to be
    // argued for here, in this file, next to the reason there is one.
    const counted = Object.fromEntries(
      files
        .map((f) => [f, (readFileSync(f, "utf8").match(/\.statement\.text\b/g) ?? []).length] as const)
        .filter(([, n]) => n > 0),
    );
    expect(counted).toEqual({});
  });

  it("never marks up a matched substring inside a statement", () => {
    // Search arrived on this surface with Task 9 and brought its conventions with it. This
    // is the one that must not land: a highlight inside a blurred statement puts precisely
    // the matched words on screen in the state whose entire purpose is that they are not
    // readable — the blur defeated by the feature meant to help read past it. It is the
    // same shape as the conflict line and the edit textarea, arriving through a third door
    // that looks like a rendering nicety rather than a decision about a secret.
    //
    // The two mechanisms a highlight actually uses, and nothing looser: prose is skipped by
    // `codeLines`, so the paragraph in `memory-topics.tsx` explaining why there is no
    // highlighting does not trip its own rule.
    const offenders = files.filter((f) =>
      codeLines(readFileSync(f, "utf8")).some((l) => /<mark[\s/>]|dangerouslySetInnerHTML/.test(l)),
    );
    expect(offenders).toEqual([]);
  });

  it("renders no reveal control inside a list row", () => {
    // A `TopicRow` is a `<button>`. `Statement`'s reveal is a `<button>` too, so a sensitive
    // title in a row nested one inside the other — invalid markup, and the inner click
    // bubbles: "Show" would OPEN the file rather than reveal the words, which is the reveal
    // control doing the one thing it exists not to do. The row therefore blurs with no
    // control at all, and the file's own view — one click away — carries the reveal.
    //
    // Source-text, like everything else here: `environment: "node"` has no renderer, so
    // "the row rendered no button" is not observable any other way.
    const owner = readFileSync(OWNER, "utf8");
    const row = owner.slice(owner.indexOf("function TopicRow"), owner.indexOf("const SECTION_KEY"));
    // Whole elements, not lines: one of these calls spans four of them.
    const statements = codeLines(row).join("\n").match(/<Statement\b[\s\S]*?\/>/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const el of statements) expect(el).toContain("control={false}");
    // And no `<p>` anywhere inside that button: a `<button>` takes phrasing content only,
    // so every text cell in the row is a `<span className="block …">`.
    expect(row).not.toMatch(/<p[\s>]/);
  });

  it("gives the open file ONE reveal over its title and its body", () => {
    // The detail view holds a `reveal` for the body — a markdown body cannot go through
    // `Statement`, so the gate is explicit there — and the title's own `Statement` was
    // taking its own. Two controls over one secret is how half of it stays on screen: the
    // title and the body carry the SAME head revision's flag, so revealing one and not the
    // other is not a state anybody asked for. The module's own docstring already said the
    // reveal is shared; this is the assertion that makes it true.
    const owner = readFileSync(OWNER, "utf8");
    const detail = owner.slice(owner.indexOf("export function MemoryTopicDetail"));
    const titleLine = codeLines(detail).find((l) => l.includes("<Statement value={topic.title}"));
    expect(titleLine).toBeDefined();
    expect(titleLine).toContain("reveal={reveal}");
  });

  it("gates a decision about a hidden statement on the reveal, not on a flag of its own", () => {
    // A source-text assertion, and deliberately so: this repo's vitest runs
    // `environment: "node"` with no renderer, so "the button is disabled" is not
    // something any test here can observe. The alternative to a brittle assertion is no
    // assertion.
    //
    // WHAT IT GUARDS MOVED WITH THE SURFACE. It was "Edit wording", the entrance where one
    // click put a sensitive statement on screen with nothing having asked. That control is
    // gone; what is there now is heavier — keeping one side of a conflict DELETES the
    // other, and keeping an archived suggestion writes a real fact — and neither is a
    // decision anybody can take against words they cannot read. Same rule, same
    // mechanism, and it is `reveal.shown` rather than a second read of the flag.
    const review = readFileSync("src/components/settings/memory-review.tsx", "utf8");
    expect(review).toMatch(/disabled=\{[^}]*!reveal\.shown[^}]*\}/);
  });
});
