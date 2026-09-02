import { describe, it, expect } from "vitest";

/**
 * The PURE half of an in-place note edit (§4.6 as task 2c extends it): the model edits the
 * text `memory_open` showed it, which is the RENDERED body — canonical edge tokens
 * substituted for their targets' current titles — while the database stores the tokens.
 *
 * No database, no mint, no context: everything here is `(storedBody, edges)` in and a new
 * stored body out, which is what makes the mapping testable at all. The integration suite
 * asserts the write; this asserts the arithmetic.
 */
import { edgeToken, UNRESOLVED_LINK } from "../links";
import { applyInsert, applyStrReplace, lineCountOf, mapRenderedToStored, type RenderedEdge } from "../note-edit";

const E1 = "edge0000000000000001";
const E2 = "edge0000000000000002";
const E3 = "edge0000000000000003";

const live = (edgeId: string, title: string | null): RenderedEdge => ({ edgeId, title });

describe("rendered <-> stored mapping", () => {
  it("maps a rendered title back to the token the body actually stores", () => {
    const stored = `See ${edgeToken(E1)} for the deadline.`;
    const r = mapRenderedToStored("See [[Reporting]] for the deadline.", stored, [live(E1, "Reporting")]);
    expect(r).toEqual({ ok: true, text: stored });
  });

  it("refuses when two live edges render as the same title", () => {
    const stored = `${edgeToken(E1)} and ${edgeToken(E2)}`;
    const r = mapRenderedToStored("[[Reporting]] and x", stored, [live(E1, "Reporting"), live(E2, "Reporting")]);
    expect(r).toEqual({ ok: false, reason: "ambiguous_link", title: "Reporting" });
  });

  it("maps the link-removed text to the ONE dead token, and refuses when there are two", () => {
    const one = `a ${edgeToken(E1)} b`;
    expect(mapRenderedToStored(`a ${UNRESOLVED_LINK} b`, one, [])).toEqual({ ok: true, text: one });

    const two = `a ${edgeToken(E1)} b ${edgeToken(E2)}`;
    expect(mapRenderedToStored(`a ${UNRESOLVED_LINK} b`, two, [])).toEqual({
      ok: false,
      reason: "ambiguous_link",
      title: "link removed",
    });
  });

  it("leaves a title no edge carries as plain text", () => {
    const stored = "The [[Plain]] stays text.";
    expect(mapRenderedToStored("The [[Plain]] stays text.", stored, [live(E1, "Reporting")])).toEqual({
      ok: true,
      text: "The [[Plain]] stays text.",
    });
  });

  it("counts lines the way the numbering does", () => {
    expect(lineCountOf("")).toBe(0);
    expect(lineCountOf("one")).toBe(1);
    expect(lineCountOf("one\n\ntwo")).toBe(3);
  });
});

describe("str_replace", () => {
  it("replaces the one exact occurrence and reports no link change", () => {
    const stored = "The deadline is the fifteenth.\n\nAsk Olena.";
    const r = applyStrReplace({ storedBody: stored, edges: [], oldStr: "fifteenth", newStr: "twentieth" });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.body).toBe("The deadline is the twentieth.\n\nAsk Olena.");
    expect(r.linksRemoved).toEqual([]);
    expect(r.fuzzy).toBe(false);
    expect(r.changedFrom).toBe(1);
    expect(r.changedTo).toBe(1);
  });

  it("refuses when old_str is not there at all", () => {
    const r = applyStrReplace({ storedBody: "one two", edges: [], oldStr: "three", newStr: "four" });
    expect(r).toEqual({ ok: false, reason: "no_match" });
  });

  it("refuses two occurrences and NAMES THE LINES they sit on", () => {
    const stored = "alpha\nbeta\nalpha\n";
    const r = applyStrReplace({ storedBody: stored, edges: [], oldStr: "alpha", newStr: "gamma" });
    expect(r).toEqual({ ok: false, reason: "ambiguous_match", lines: [1, 3] });
  });

  it("an empty new_str is a deletion", () => {
    const r = applyStrReplace({ storedBody: "keep this drop that", edges: [], oldStr: " drop that", newStr: "" });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.body).toBe("keep this");
  });

  it("reports the links the edit dropped, and keeps the ones it did not", () => {
    const stored = `A ${edgeToken(E1)} B ${edgeToken(E2)}`;
    const r = applyStrReplace({
      storedBody: stored,
      edges: [live(E1, "Reporting"), live(E2, "Payroll")],
      oldStr: "A [[Reporting]] B",
      newStr: "A B",
    });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.linksRemoved).toEqual([E1]);
    expect(r.body).toBe(`A B ${edgeToken(E2)}`);
  });

  it("keeps a link the replacement still mentions by title", () => {
    const stored = `A ${edgeToken(E1)} B`;
    const r = applyStrReplace({
      storedBody: stored,
      edges: [live(E1, "Reporting")],
      oldStr: "A [[Reporting]] B",
      newStr: "C [[Reporting]] D",
    });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.body).toBe(`C ${edgeToken(E1)} D`);
    expect(r.linksRemoved).toEqual([]);
  });

  it("refuses a canonical token typed into new_str that old_str did not carry", () => {
    const r = applyStrReplace({
      storedBody: "plain body",
      edges: [],
      oldStr: "plain",
      newStr: `plain ${edgeToken(E3)}`,
    });
    expect(r).toEqual({ ok: false, reason: "bad_link" });
  });

  it("leaves [[Plain]] in new_str as text rather than minting a link", () => {
    const r = applyStrReplace({ storedBody: "one two", edges: [], oldStr: "two", newStr: "[[Plain]]" });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.body).toBe("one [[Plain]]");
    expect(r.body).not.toContain("capka-edge");
  });

  it("matches a CRLF body byte-exactly in the exact tier", () => {
    const stored = "one\r\ntwo\r\nthree";
    const r = applyStrReplace({ storedBody: stored, edges: [], oldStr: "one\r\ntwo", newStr: "ONE\r\nTWO" });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.body).toBe("ONE\r\nTWO\r\nthree");
    expect(r.fuzzy).toBe(false);
  });

  it("falls back once, whitespace-tolerantly, and replaces the STORED span", () => {
    // The line carries a trailing space and a double space the model did not reproduce.
    const stored = "The  deadline is the fifteenth.  \nAsk Olena.";
    const r = applyStrReplace({
      storedBody: stored,
      edges: [],
      oldStr: "The deadline is the fifteenth.",
      newStr: "The deadline is the twentieth.",
    });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.fuzzy).toBe(true);
    expect(r.body).toBe("The deadline is the twentieth.  \nAsk Olena.");
  });

  it("the fallback refuses two matches rather than picking one", () => {
    const stored = "The  deadline is  here.\nThe deadline is here.";
    const r = applyStrReplace({
      storedBody: stored,
      edges: [],
      oldStr: "The deadline  is here.",
      newStr: "gone",
    });
    expect(r).toEqual({ ok: false, reason: "ambiguous_match", lines: [1, 2] });
  });
});

describe("insert", () => {
  it("inserts AFTER the given line, and 0 puts it first", () => {
    const stored = "one\ntwo";
    const at1 = applyInsert({ storedBody: stored, insertLine: 1, insertText: "middle" });
    if (!at1.ok) throw new Error(`expected ok, got ${at1.reason}`);
    expect(at1.body).toBe("one\nmiddle\ntwo");
    expect(at1.changedFrom).toBe(2);
    expect(at1.changedTo).toBe(2);

    const at0 = applyInsert({ storedBody: stored, insertLine: 0, insertText: "first" });
    if (!at0.ok) throw new Error(`expected ok, got ${at0.reason}`);
    expect(at0.body).toBe("first\none\ntwo");
  });

  it("appends at the last line and refuses one past it", () => {
    const stored = "one\ntwo";
    const at2 = applyInsert({ storedBody: stored, insertLine: 2, insertText: "last" });
    if (!at2.ok) throw new Error(`expected ok, got ${at2.reason}`);
    expect(at2.body).toBe("one\ntwo\nlast");

    expect(applyInsert({ storedBody: stored, insertLine: 3, insertText: "x" })).toEqual({
      ok: false,
      reason: "bad_line",
      lines: 2,
    });
    expect(applyInsert({ storedBody: stored, insertLine: -1, insertText: "x" })).toEqual({
      ok: false,
      reason: "bad_line",
      lines: 2,
    });
  });

  it("trims one trailing newline off the inserted text and keeps multi-line inserts whole", () => {
    const r = applyInsert({ storedBody: "one", insertLine: 1, insertText: "a\nb\n" });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.body).toBe("one\na\nb");
    expect(r.changedFrom).toBe(2);
    expect(r.changedTo).toBe(3);
  });

  it("refuses a canonical token typed into the inserted text", () => {
    expect(applyInsert({ storedBody: "one", insertLine: 1, insertText: `see ${edgeToken(E1)}` })).toEqual({
      ok: false,
      reason: "bad_link",
    });
  });

  it("inserts into an empty body at line 0", () => {
    const r = applyInsert({ storedBody: "", insertLine: 0, insertText: "first" });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.body).toBe("first");
  });
});
