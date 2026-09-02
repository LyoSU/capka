import { describe, it, expect } from "vitest";
import {
  EDGE_TOKEN_RE,
  UNRESOLVED_LINK,
  edgeIdsIn,
  edgeToken,
  serializeBlocks,
  substituteTokens,
  type NoteBlock,
} from "../links";

/**
 * The token format and the block serializer, with no database in it. The parts that read
 * rows (`edgeTargets`, `renderBody`) are covered by `note-write.integration.test.ts`, which
 * has notes to rename.
 */

describe("canonical edge tokens", () => {
  it("round-trips an id through the token and the pattern", () => {
    const id = "V1StGXR8_Z5jdHi6B-my";
    expect(edgeToken(id)).toBe(`[[capka-edge:${id}]]`);
    expect(edgeIdsIn(`see ${edgeToken(id)} and again ${edgeToken(id)}`)).toEqual([id]);
  });

  it("does not match a model-typed [[Title]]", () => {
    // The whole of §7's "the model cannot type a persistent link": a title in double
    // brackets is literal text and mints nothing. Asserted on the PATTERN as well as on the
    // writer, because a widened pattern would turn every existing note's prose into links.
    expect(edgeIdsIn("see [[Reporting]] and [[capka-edge:]] and [[capka-edge:a b]]")).toEqual([]);
    expect(new RegExp(EDGE_TOKEN_RE.source).test("[[Reporting]]")).toBe(false);
  });

  it("survives being asked twice — the shared /g/ regex carries no lastIndex into a caller", () => {
    // `EDGE_TOKEN_RE` is /g/, so a caller reusing the exported instance would get a
    // different answer the second time. Both readers build a fresh one; this is the control.
    const body = `a ${edgeToken("aaa")} b`;
    expect(edgeIdsIn(body)).toEqual(["aaa"]);
    expect(edgeIdsIn(body)).toEqual(["aaa"]);
    expect(substituteTokens(body, () => "T")).toBe("a [[T]] b");
    expect(substituteTokens(body, () => "T")).toBe("a [[T]] b");
  });

  it("renders an unresolved token as text that carries no id", () => {
    const body = edgeToken("gone123");
    const rendered = substituteTokens(body, () => null);
    expect(rendered).toBe(UNRESOLVED_LINK);
    expect(rendered).not.toContain("gone123");
  });
});

describe("serializeBlocks", () => {
  const blocks: NoteBlock[] = [
    { kind: "markdown", text: "The deadline is Friday." },
    { kind: "node_link", targetHandle: "n7" },
    { kind: "markdown", text: "Ask before then." },
  ];

  it("turns a node_link into the edge's token and leaves markdown verbatim", () => {
    const body = serializeBlocks(blocks, (h) => (h === "n7" ? "edge7" : ""));
    expect(body).toBe(`The deadline is Friday.\n\n${edgeToken("edge7")}\n\nAsk before then.`);
  });

  it("throws on a handle with no edge rather than dropping the block", () => {
    // A note saved with half its links is the state §4.1 rejects the whole mutation for, so
    // a serializer that skipped one would produce exactly what the rejection exists to
    // prevent — and it would do it silently.
    expect(() => serializeBlocks(blocks, () => "")).toThrow(/n7/);
  });
});
