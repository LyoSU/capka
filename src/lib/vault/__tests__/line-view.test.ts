import { describe, it, expect } from "vitest";

/**
 * `pageLines` — the numbering and paging `memory_open` hands a note back in.
 *
 * A UNIT SUITE, with no database, because the whole contract is a wire format: the `cat -n`
 * column, the byte budget, and a cursor grammar the model is expected to echo back verbatim.
 * Until now it was pinned only from `memory-open.integration.test.ts`, which skips without
 * `RUN_INTEGRATION` — so the format that decides what a cursor means was reachable only on a
 * machine with Postgres running.
 */
import { numberLine, pageLines } from "../line-view";

/** Six right-aligned digits and a tab, so a prefix is exactly seven bytes. */
const PREFIX_BYTES = 7;

describe("pageLines", () => {
  it("numbers from 1 and reports the range it covered", () => {
    const p = pageLines("alpha\nbeta\ngamma", undefined, 8_000);
    expect(p).toEqual({
      text: "     1\talpha\n     2\tbeta\n     3\tgamma",
      next: null,
      from: 1,
      to: 3,
      total: 3,
    });
    expect(numberLine(1, "alpha")).toBe("     1\talpha");
    expect(Buffer.byteLength(numberLine(9, ""), "utf8")).toBe(PREFIX_BYTES);
  });

  it("cuts on a LINE boundary inside the budget, and the cursor resumes exactly there", () => {
    // Twenty bytes fits one numbered line of five characters (7 + 5) and not a second
    // (+1 for the joining newline, +7 for its prefix, +4 for "beta" = 24).
    const first = pageLines("alpha\nbeta\ngamma", undefined, 20);
    expect(first).toMatchObject({ text: "     1\talpha", next: "l2", from: 1, to: 1, total: 3 });
    expect(Buffer.byteLength(first!.text, "utf8")).toBeLessThanOrEqual(20);

    const second = pageLines("alpha\nbeta\ngamma", first!.next!, 20);
    expect(second).toMatchObject({ text: "     2\tbeta", next: "l3", from: 2, to: 2 });

    const third = pageLines("alpha\nbeta\ngamma", second!.next!, 20);
    expect(third).toMatchObject({ text: "     3\tgamma", next: null, from: 3, to: 3 });
  });

  it("every line appears exactly once across the pages, under the number the file gives it", () => {
    // The invariant that replaced raw concatenation once the pages became numbered.
    const body = ["one", "two", "three", "four", "five"].join("\n");
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const p = pageLines(body, cursor, 20);
      if (!p) throw new Error("unexpected bad cursor");
      seen.push(...p.text.split("\n"));
      if (!p.next) break;
      cursor = p.next;
    }
    expect(seen).toEqual([
      "     1\tone",
      "     2\ttwo",
      "     3\tthree",
      "     4\tfour",
      "     5\tfive",
    ]);
  });

  it("refuses a cursor it did not hand out, in every shape", () => {
    const body = "alpha\nbeta";
    // A BARE NUMBER IS NOT A CURSOR. Without the prefix a fabricated value that happens to be
    // a valid line index is indistinguishable from one this function emitted.
    expect(pageLines(body, "1", 8_000)).toBeNull();
    expect(pageLines(body, "l0", 8_000)).toBeNull();
    expect(pageLines(body, "l3", 8_000)).toBeNull();
    expect(pageLines(body, "nope", 8_000)).toBeNull();
    expect(pageLines(body, "l1.99", 8_000)).toBeNull();
    // A byte offset equal to the line's length is never emitted either: a page that consumed
    // a whole line moves to the next one.
    expect(pageLines(body, "l1.5", 8_000)).toBeNull();
    // The control: line 1 at byte 0 and at an interior boundary are both real addresses.
    expect(pageLines(body, "l1", 8_000)).toMatchObject({ from: 1 });
    // A mid-line resume keeps line 1's number on the piece it opens with, and the page runs
    // on into the next line as any other would.
    expect(pageLines(body, "l1.2", 8_000)).toEqual({
      text: "     1\tpha\n     2\tbeta",
      next: null,
      from: 1,
      to: 2,
      total: 2,
    });
  });

  it("an empty body is one empty page, and takes no cursor at all", () => {
    expect(pageLines("", undefined, 8_000)).toEqual({ text: "", next: null, from: 0, to: 0, total: 0 });
    // `0/0/0` rather than `1/1/1`: a file with no lines has no first line to name, and a
    // header saying "lines 1-1 of 1" would be describing a line that is not there.
    expect(pageLines("", "l1", 8_000)).toBeNull();
  });

  it("a single line longer than the budget is cut on a CHARACTER boundary and keeps its number", () => {
    // One character of each UTF-8 width above ASCII — 2 + 3 + 4 bytes — so a cut taken at an
    // arbitrary byte offset lands inside a character eight times out of nine.
    const multibyte = "é€𝄞";
    const body = multibyte.repeat(20);
    const first = pageLines(body, undefined, 40);
    if (!first) throw new Error("unexpected bad cursor");
    expect(first.text.startsWith("     1\t")).toBe(true);
    expect(first.text).not.toContain("�");
    expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(40);
    // THE SAME NUMBER on the continuation, and a cursor carrying the byte offset — a second
    // number for one line would be an address that addresses nothing.
    expect(first.next).toMatch(/^l1\.[0-9]+$/);
    expect(first.to).toBe(1);

    let assembled = first.text.replace(/^ *\d+\t/, "");
    let cursor = first.next;
    let pages = 1;
    while (cursor) {
      const p = pageLines(body, cursor, 40);
      if (!p) throw new Error("unexpected bad cursor");
      expect(p.text.startsWith("     1\t")).toBe(true);
      expect(p.text).not.toContain("�");
      assembled += p.text.replace(/^ *\d+\t/, "");
      cursor = p.next;
      pages += 1;
      if (pages > 40) throw new Error("cursor did not terminate");
    }
    // ONE line, so the pieces really do abut: this is the one case where concatenation is
    // still the right reading.
    expect(assembled).toBe(body);
  });

  it("a budget below one prefix still advances rather than looping", () => {
    // PINNED BECAUSE IT IS NOT OBVIOUS. `pageLines` floors the budget at 16 bytes and, when
    // even the first character will not fit, emits one character over budget. Both exist so
    // the returned cursor is always ahead of the one that produced it — an empty page with an
    // unchanged cursor is a caller that never terminates. No real caller is near this: the
    // smallest budget in the codebase is 2,000.
    const p = pageLines("alpha", undefined, 1);
    if (!p) throw new Error("unexpected bad cursor");
    expect(p.text).toBe("     1\talpha");
    expect(p.next).toBeNull();

    const long = pageLines("abcdefghijklmnopqrstuvwxyz", undefined, 1);
    if (!long) throw new Error("unexpected bad cursor");
    expect(long.text).toBe("     1\tabcdefghi");
    expect(long.next).toBe("l1.9");
  });
});
