import { describe, it, expect } from "vitest";
import { firstJsonValue, repairConcatenatedInput } from "../tool-repair";

describe("repairConcatenatedInput", () => {
  it("keeps the first of several calls emitted as one", () => {
    // Verbatim shape of the failure: three read_file calls with nothing between them, which
    // JSON.parse rejects wholesale ("Unexpected non-whitespace character after JSON").
    const input =
      '{"max_lines":100,"offset":1,"path":"capka-landing/sitemap.xml"}' +
      '{"offset":1,"max_lines":100,"path":"capka-landing/robots.txt"}' +
      '{"offset":1,"path":"capka-landing/llms.txt","max_lines":100}';
    expect(JSON.parse(repairConcatenatedInput(input)!)).toEqual({
      max_lines: 100, offset: 1, path: "capka-landing/sitemap.xml",
    });
  });

  it("leaves a well-formed call alone", () => {
    expect(repairConcatenatedInput('{"path":"a.txt"}')).toBeNull();
    expect(repairConcatenatedInput('  {"path":"a.txt"}  ')).toBeNull();
  });

  it("refuses arguments that are merely broken, rather than guessing a call", () => {
    // A truncated tail is NOT a second call, so there is no "first one" to honour — the
    // model must see its own error instead of a request it never made.
    expect(repairConcatenatedInput('{"path":"a.txt"}{"path":')).toBeNull();
    expect(repairConcatenatedInput('{"path":"a.txt"} trailing prose')).toBeNull();
    expect(repairConcatenatedInput('not json at all')).toBeNull();
    expect(repairConcatenatedInput('{"path":"a.txt"')).toBeNull();
  });

  it("does not end an object early on a brace or quote inside a string", () => {
    const input = '{"path":"a{b}c","note":"say \\"hi\\""}{"path":"second.txt"}';
    expect(JSON.parse(repairConcatenatedInput(input)!)).toEqual({ path: "a{b}c", note: 'say "hi"' });
  });

  it("handles nesting and arrays", () => {
    const input = '{"only":["a","b"],"opts":{"deep":{"x":1}}}{"only":["c"]}';
    expect(JSON.parse(repairConcatenatedInput(input)!)).toEqual({ only: ["a", "b"], opts: { deep: { x: 1 } } });
  });

  it("reports where the first value ended so the rest can be checked", () => {
    expect(firstJsonValue('{"a":1}{"b":2}')).toEqual({ value: { a: 1 }, end: 7 });
    expect(firstJsonValue("   ")).toBeNull();
  });
});
