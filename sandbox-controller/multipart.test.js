import { describe, it, expect } from "vitest";
import { parseBoundary, parseMultipart } from "./multipart.js";

const B = "----WebKitFormBoundary7MA4YWxkTrZu0gW";

/** Build a multipart body buffer from parts. Each part is a text field or a
 *  file (data may be a Buffer to test binary integrity). */
function build(parts, boundary = B) {
  const segs = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += "\r\n";
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += "\r\n";
    segs.push(Buffer.from(head, "utf8"));
    segs.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data), "utf8"));
    segs.push(Buffer.from("\r\n", "utf8"));
  }
  segs.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(segs);
}

describe("parseBoundary", () => {
  it("reads a bare boundary", () => {
    expect(parseBoundary(`multipart/form-data; boundary=${B}`)).toBe(B);
  });
  it("reads a quoted boundary and ignores trailing params", () => {
    expect(parseBoundary(`multipart/form-data; boundary="${B}"; charset=utf-8`)).toBe(B);
  });
  it("returns null when absent", () => {
    expect(parseBoundary("application/json")).toBeNull();
    expect(parseBoundary("")).toBeNull();
  });
  it("returns null for a non-multipart type that merely contains boundary=", () => {
    // A request that isn't multipart/form-data must not be treated as an upload
    // just because the header string happens to include a boundary= token.
    expect(parseBoundary(`application/json; boundary=${B}`)).toBeNull();
  });
});

describe("parseMultipart", () => {
  const ct = `multipart/form-data; boundary=${B}`;

  it("extracts text fields and a named file", () => {
    const body = build([
      { name: "path", data: "subdir/nested" },
      { name: "file", filename: "hello.txt", data: "hello world", contentType: "text/plain" },
    ]);
    const r = parseMultipart(body, ct);
    expect(r.fields.path).toBe("subdir/nested");
    expect(r.files).toHaveLength(1);
    expect(r.files[0].field).toBe("file");
    expect(r.files[0].filename).toBe("hello.txt");
    expect(r.files[0].data.toString("utf8")).toBe("hello world");
  });

  it("preserves binary content byte-for-byte, incl. embedded CRLF and dashes", () => {
    // Bytes that include CRLFs and a run of dashes resembling a boundary lead-in,
    // plus a 0x00 — exactly the shape that trips naive string handling.
    const payload = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x2d, 0x2d, 0x2d,
      0x57, 0x65, 0x62, 0x4b, 0x69, 0x74, 0x0d, 0x0a, 0xff, 0xd8, 0xff,
    ]);
    const body = build([
      { name: "path", data: "." },
      { name: "file", filename: "img.png", data: payload, contentType: "image/png" },
    ]);
    const r = parseMultipart(body, ct);
    expect(r.files[0].data.equals(payload)).toBe(true);
    expect(r.files[0].data).toHaveLength(payload.length);
  });

  it("handles a file with no trailing extra and an empty path field", () => {
    const body = build([
      { name: "path", data: "" },
      { name: "file", filename: "a.bin", data: Buffer.from([1, 2, 3]) },
    ]);
    const r = parseMultipart(body, ct);
    expect(r.fields.path).toBe("");
    expect(r.files[0].data.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("returns null for a malformed content-type", () => {
    expect(parseMultipart(Buffer.from("x"), "application/json")).toBeNull();
  });

  it("returns empty result when the boundary never appears in the body", () => {
    const r = parseMultipart(Buffer.from("not multipart at all"), ct);
    expect(Object.keys(r.fields)).toHaveLength(0);
    expect(r.files).toEqual([]);
  });

  it("ignores prototype-polluting field names and uses a null-prototype object", () => {
    const body = build([
      { name: "__proto__", data: "polluted" },
      { name: "constructor", data: "polluted" },
      { name: "prototype", data: "polluted" },
      { name: "path", data: "ok" },
    ]);
    const r = parseMultipart(body, ct);
    expect(r.fields.path).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(r.fields, "__proto__")).toBe(false);
    expect(({}).polluted).toBeUndefined(); // Object.prototype untouched
    expect(Object.getPrototypeOf(r.fields)).toBeNull();
  });

  it("drops a text field larger than the per-field cap", () => {
    const body = build([
      { name: "path", data: "x".repeat(64 * 1024 + 1) },
      { name: "file", filename: "a.bin", data: Buffer.from([1]) },
    ]);
    const r = parseMultipart(body, ct);
    expect(r.fields.path).toBeUndefined(); // oversize field skipped
    expect(r.files).toHaveLength(1); // file content is NOT subject to the field cap
  });
});
