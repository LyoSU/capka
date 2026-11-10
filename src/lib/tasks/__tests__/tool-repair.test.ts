import { describe, it, expect } from "vitest";
import { InvalidToolInputError, NoSuchToolError } from "ai";
import { coerceToSchema, firstJsonValue, repairConcatenatedInput, repairToolCall } from "../tool-repair";

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

describe("coerceToSchema", () => {
  const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ type: "object", properties, ...extra });

  it("coerces numeric and boolean strings", () => {
    const s = obj({ n: { type: "integer" }, f: { type: "number" }, b: { type: "boolean" } });
    expect(coerceToSchema({ n: "20", f: "1.5", b: "false" }, s)).toEqual({ n: 20, f: 1.5, b: false });
    // Not a safe integer / not finite / blank: left for the validator to reject.
    expect(coerceToSchema({ n: "1.5", f: "", b: "yes" }, s)).toEqual({ n: "1.5", f: "", b: "yes" });
    expect(coerceToSchema({ n: "9007199254740993" }, s)).toEqual({ n: "9007199254740993" });
  });

  it("parses stringified objects and arrays", () => {
    const s = obj({ o: obj({ a: { type: "number" } }), l: { type: "array", items: { type: "string" } } });
    expect(coerceToSchema({ o: '{"a":"1"}', l: '["x"]' }, s)).toEqual({ o: { a: 1 }, l: ["x"] });
  });

  it("drops an optional property sent as null or {}, never a required one", () => {
    const s = obj({ a: { type: "string" }, b: { type: "number" }, c: { type: "string" } }, { required: ["c"] });
    expect(coerceToSchema({ a: null, b: {}, c: "x" }, s)).toEqual({ c: "x" });
    expect(coerceToSchema({ c: null }, s)).toEqual({ c: null });
  });

  it("keeps null where the property is nullable or an enum", () => {
    const s = obj({ a: { anyOf: [{ type: "string" }, { type: "null" }] }, e: { type: "string", enum: ["x"] } });
    expect(coerceToSchema({ a: null, e: null }, s)).toEqual({ a: null, e: null });
  });

  it("wraps a bare value only when it fits the item type", () => {
    const s = obj({ n: { type: "array", items: { type: "integer" } }, t: { type: "array", items: { type: "string" } } });
    expect(coerceToSchema({ n: "2", t: "a" }, s)).toEqual({ n: [2], t: ["a"] });
    expect(coerceToSchema({ n: "two", t: 5 }, s)).toEqual({ n: "two", t: 5 });
  });

  it("recurses into nested objects and array items", () => {
    const s = obj({ items: { type: "array", items: obj({ n: { type: "integer" } }) } });
    expect(coerceToSchema({ items: [{ n: "1" }, { n: "2" }] }, s)).toEqual({ items: [{ n: 1 }, { n: 2 }] });
  });

  it("drops undeclared keys on a closed object only", () => {
    const closed = obj({ a: { type: "string" } }, { additionalProperties: false });
    expect(coerceToSchema({ a: "x", z: 1 }, closed)).toEqual({ a: "x" });
    expect(coerceToSchema({ a: "x", z: 1 }, obj({ a: { type: "string" } }))).toEqual({ a: "x", z: 1 });
    const composed = obj({ a: { type: "string" } }, { additionalProperties: false, anyOf: [{}] });
    expect(coerceToSchema({ a: "x", z: 1 }, composed)).toEqual({ a: "x", z: 1 });
  });

  it("leaves ambiguity alone: multi-type unions, $ref", () => {
    const s = obj({
      u: { anyOf: [{ type: "number" }, { type: "boolean" }] },
      r: { $ref: "#/$defs/N" },
      m: { type: ["number", "boolean"] },
    });
    expect(coerceToSchema({ u: "1", r: "1", m: "true" }, s)).toEqual({ u: "1", r: "1", m: "true" });
  });

  it("does not touch a numeric-looking string under a string schema", () => {
    expect(coerceToSchema({ s: "20" }, obj({ s: { type: "string" } }))).toEqual({ s: "20" });
  });

  it("unwraps T | null to T", () => {
    const s = obj({ n: { anyOf: [{ type: "number" }, { type: "null" }] } });
    expect(coerceToSchema({ n: "3" }, s)).toEqual({ n: 3 });
  });
});

describe("repairToolCall", () => {
  const schema = { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false };
  const inputSchema = async () => schema;
  const invalid = (input: string) => new InvalidToolInputError({ toolName: "t", toolInput: input, cause: new Error("x") });
  const call = (input: string) => ({ toolCallId: "1", toolName: "t", input });

  it("coerces and returns a call with the same shape", async () => {
    const r = await repairToolCall({ toolCall: call('{"limit":"20","x":1}'), error: invalid(""), inputSchema });
    expect(r).toMatchObject({ toolCallId: "1", toolName: "t" });
    expect(JSON.parse(r!.input)).toEqual({ limit: 20 });
  });

  it("returns null when nothing changes", async () => {
    expect(await repairToolCall({ toolCall: call('{"limit":20}'), error: invalid(""), inputSchema })).toBeNull();
  });

  it("returns null for unparseable input and for unknown tools", async () => {
    expect(await repairToolCall({ toolCall: call('{"limit":'), error: invalid(""), inputSchema })).toBeNull();
    const nope = new NoSuchToolError({ toolName: "t" });
    expect(await repairToolCall({ toolCall: call('{"limit":"20"}'), error: nope, inputSchema })).toBeNull();
  });

  it("still repairs concatenated JSON, then coerces the first object", async () => {
    const r = await repairToolCall({ toolCall: call('{"limit":"5"}{"limit":"6"}'), error: invalid(""), inputSchema });
    expect(JSON.parse(r!.input)).toEqual({ limit: 5 });
    const plain = await repairToolCall({ toolCall: call('{"limit":5}{"limit":6}'), error: invalid("") });
    expect(JSON.parse(plain!.input)).toEqual({ limit: 5 });
  });

  it("survives a schema lookup that throws", async () => {
    const boom = async () => { throw new Error("no"); };
    expect(await repairToolCall({ toolCall: call('{"limit":"20"}'), error: invalid(""), inputSchema: boom })).toBeNull();
  });
});
