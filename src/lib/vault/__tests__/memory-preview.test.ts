import { describe, it, expect } from "vitest";
import { firstParagraph } from "../memory-page";

/**
 * The row's second line, as a pure function — no database, so it runs in the ordinary
 * suite beside the integration file rather than behind the gate.
 *
 * Every case here is a shape the reference's own files have: a `Summary` heading first, a
 * body that is nothing but bullets, a link block, and a file with no prose at all.
 */
describe("firstParagraph", () => {
  it("skips a heading and returns the paragraph under it", () => {
    expect(firstParagraph("## Summary\n\nReports go out on Fridays.")).toBe("Reports go out on Fridays.");
    // A RUN of headings, which is what a file opening `# Title` then `## Summary` gives:
    // blocks are split on blank lines, so two heading lines with no blank between them are
    // one block and the whole block is skipped.
    expect(firstParagraph("# Beans\n# Beans again\n\nThe dog.")).toBe("The dog.");
  });

  it("strips inline markdown without losing the words", () => {
    expect(firstParagraph("Sent **before** noon, see [the calendar](https://x.test).")).toBe(
      "Sent before noon, see the calendar.",
    );
    expect(firstParagraph("A `code` word and _emphasis_.")).toBe("A code word and emphasis.");
  });

  it("falls back to a LIST when the file has no plain paragraph", () => {
    // A file that is a heading and five bullets is common, and "no preview" reads as an
    // empty file rather than a full one.
    expect(firstParagraph("## Details\n\n- Sent by Olena\n- Cc the client")).toBe("Sent by Olena Cc the client");
  });

  it("skips a block that is nothing but a link, and a fence", () => {
    // A resolved edge token renders as `[[Some title]]`; a dead one as `[[link removed]]`.
    // Neither is prose, and the second as a preview would describe the page's plumbing.
    expect(firstParagraph("[[Acme payment terms]]\n\nNet 30 from the invoice date.")).toBe(
      "Net 30 from the invoice date.",
    );
    expect(firstParagraph("```sql\nselect 1\n```\n\nThe nightly query.")).toBe("The nightly query.");
  });

  it("is empty for a file nothing has written into", () => {
    expect(firstParagraph("")).toBe("");
    expect(firstParagraph("## Summary\n\n## Details")).toBe("");
  });

  it("does not truncate", () => {
    // The row clips in CSS, at the column's real width in the reader's own font. A JS
    // slice at N characters is either short of the line or spilling out of it, and it is
    // wrong differently in every locale.
    const long = `${"word ".repeat(200)}end`;
    expect(firstParagraph(long)).toContain("end");
  });
});
