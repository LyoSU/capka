/**
 * Minimal multipart/form-data parser for the controller's file-upload endpoint.
 * Extracted from server.js so it can be unit-tested (server.js exits at import
 * without CONTROLLER_SECRET). Operates on a fully-buffered body — the caller
 * bounds size via MAX_UPLOAD before calling — and preserves binary content
 * byte-for-byte. This is intentionally small (handles the fields the platform
 * sends: a "path" text field and a "file" file field), not a general RFC 2388
 * implementation.
 */

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;

/** Extract the boundary token from a Content-Type header, tolerating an
 *  optionally-quoted value and trailing parameters (`; charset=...`). Requires the
 *  media type to actually be multipart/form-data — an unrelated content type that
 *  merely contains a `boundary=` token must not be parsed as an upload. */
export function parseBoundary(contentType) {
  const ct = contentType || "";
  if (!/^\s*multipart\/form-data\s*;/i.test(ct)) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) return null;
  const b = (m[1] ?? m[2] ?? "").trim();
  return b || null;
}

/**
 * Parse a buffered multipart body. Returns { fields, files } where fields maps
 * a text field name to its string value and files is a list of
 * { field, filename, data:Buffer }. Returns null only when no boundary can be
 * derived (malformed Content-Type).
 */
// Text fields are small control values (just "path"); cap them so a crafted body
// can't stash megabytes in a field. The file content uses the separate upload cap.
const MAX_FIELD_BYTES = 64 * 1024;
// Reserved keys that would pollute Object.prototype if assigned. We also use a
// null-prototype fields object, so this is belt-and-suspenders.
const POLLUTING = new Set(["__proto__", "constructor", "prototype"]);

export function parseMultipart(body, contentType) {
  const boundary = parseBoundary(contentType);
  if (!boundary) return null;

  const delim = Buffer.from(`--${boundary}`);
  const fields = Object.create(null);
  const files = [];

  let pos = body.indexOf(delim);
  if (pos === -1) return { fields, files };
  pos += delim.length;

  while (pos < body.length) {
    // A closing delimiter is "--boundary--"; stop there.
    if (body[pos] === DASH && body[pos + 1] === DASH) break;
    // Skip the CRLF that follows the delimiter line.
    if (body[pos] === CR && body[pos + 1] === LF) pos += 2;

    const next = body.indexOf(delim, pos);
    if (next === -1) break;

    // The part ends just before the next delimiter, minus the trailing CRLF
    // that separates content from the delimiter.
    let end = next;
    if (body[end - 2] === CR && body[end - 1] === LF) end -= 2;

    const part = body.slice(pos, end);
    const sep = part.indexOf("\r\n\r\n");
    if (sep !== -1) {
      const headers = part.slice(0, sep).toString("utf8");
      const content = part.slice(sep + 4);
      const name = /name="([^"]*)"/i.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
      if (filename !== undefined) {
        files.push({ field: name ?? "", filename, data: content });
      } else if (name !== undefined && !POLLUTING.has(name) && content.length <= MAX_FIELD_BYTES) {
        fields[name] = content.toString("utf8");
      }
    }
    pos = next + delim.length;
  }

  return { fields, files };
}
