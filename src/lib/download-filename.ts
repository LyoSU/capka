// One source of truth for the name of every file we hand a browser: workspace
// archives, per-turn file bundles, chat exports. The audience is office staff on
// whatever machine they were given, so a name has to survive Windows, macOS and
// Linux alike — and the failure that matters most is the SILENT one: Windows does
// not reject `report...`, it saves it as `report`, so the file the user gets is
// not the file we named.

// Windows refuses these device names outright, and it resolves the device from the
// name BEFORE the first dot — `CON.md` is as unsaveable as `CON`. The superscript
// spellings (COM¹, LPT²) are reserved alongside the ASCII digits.
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

// Bytes, not characters: filesystem limits are byte-based (255 on ext4/APFS) and
// Cyrillic costs 2 bytes per character, emoji 4. 120 leaves generous room for the
// date suffix and extension a caller appends.
const MAX_NAME_BYTES = 120;

const encoder = new TextEncoder();

/** Truncate to a byte budget without splitting a character. `for...of` walks code
 *  POINTS, so a 4-byte emoji is kept or dropped whole — `slice` would cut a
 *  surrogate pair in half and leave U+FFFD in the name. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (encoder.encode(value).length <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

function clean(value: string): string {
  const normalized = value
    // Newlines and tabs carry a word boundary (a chat titled "Звіт\nза Q4"
    // should read "Звіт за Q4", not "Звітза Q4"); other control characters
    // carry nothing and go.
    .replace(/[\r\n\t\v\f]/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, "")
    // Forbidden on Windows, and `/` would silently split the name into a path
    // on every OS.
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot hides the file on macOS/Linux; a leading dash reads as a
    // flag to any command-line tool the user pipes it through. This also
    // reduces `.` and `..` to nothing, so a relative path can never be a name.
    .replace(/^[.\-]+/, "");
  // Trailing dots/spaces are trimmed AFTER truncating too: cutting to the byte
  // budget can expose a fresh one, and Windows would silently swallow it.
  return truncateToBytes(normalized.replace(/[.\s]+$/, ""), MAX_NAME_BYTES).replace(/[.\s]+$/, "");
}

/** Break a Windows device-name match by appending to the FIRST dot-separated
 *  component, since that is the part Windows resolves the device from. Appending
 *  at the end would not help: `NUL.txt-` still starts with `NUL.`. A reserved word
 *  is still a name the user recognizes, so it is kept and defused rather than
 *  thrown away for a generic fallback. */
function defuseDeviceName(name: string): string {
  const dot = name.indexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  if (!RESERVED_DEVICE_NAME.test(stem)) return name;
  return dot === -1 ? `${stem}-` : `${stem}-${name.slice(dot)}`;
}

/** Turn a user-supplied label (project name, chat title, folder name) into a
 *  filename component that saves correctly on every OS. Returns `fallback`
 *  (itself sanitized) when nothing usable survives. Extension NOT included —
 *  callers append their own. */
export function safeFilename(raw: string | null | undefined, fallback: string): string {
  const cleaned = typeof raw === "string" ? clean(raw) : "";
  if (cleaned) return defuseDeviceName(cleaned);
  const safeFallback = clean(fallback);
  return safeFallback ? defuseDeviceName(safeFallback) : "download";
}

/** Name an archive after what is inside it, dated: `Квартальний звіт — 2026-08-22.zip`.
 *  The label leads so a file manager sorted by name groups every download of the
 *  same workspace together, and the date makes yesterday's backup distinguishable
 *  from today's instead of `workspace (3).zip`.
 *
 *  The date is UTC: these downloads happen through a plain `<a href>` (the
 *  delete-project dialog has no JS in the path), so the server never learns the
 *  client's timezone, and one stable spelling per day beats a shifting one. */
export function archiveFilename(
  label: string | null | undefined,
  fallback: string,
  ext: string,
  now: Date = new Date(),
): string {
  const day = now.toISOString().slice(0, 10);
  return `${safeFilename(label, fallback)} — ${day}.${ext}`;
}

// RFC 8187 attr-char: the ONLY bytes allowed raw in an ext-value. Everything else
// must be percent-encoded. `encodeURIComponent` is not a substitute — it leaves
// ! ~ * ' ( ) alone, and a raw `'` is especially wrong here because `'` is the
// delimiter inside `filename*=UTF-8''<value>` itself.
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

/** Percent-encode a name as an RFC 8187 ext-value: UTF-8 bytes, everything outside
 *  attr-char escaped. A browser is free to ignore a malformed `filename*` and fall
 *  back to the ASCII name, which for a Cyrillic title is unreadable. */
function extValue(name: string): string {
  let out = "";
  for (const byte of encoder.encode(name)) {
    const char = String.fromCharCode(byte);
    out += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Build a `Content-Disposition` value carrying `filename` intact. RFC 6266: the
 *  `filename*` form is what every current browser reads, and the quoted ASCII
 *  `filename` is the fallback — which must itself be ASCII, quote-free and
 *  free of CR/LF (a newline here would be response splitting). `inline` is for a
 *  file the browser should render in place (an image preview) rather than save. */
export function contentDisposition(filename: string, kind: "attachment" | "inline" = "attachment"): string {
  const ascii = filename
    // The separator we put in every archive name deserves better than `_`.
    .replace(/[—–―]/g, "-")
    // Covers non-ASCII AND control characters (both fall outside 0x20-0x7E).
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
  const safeAscii = /[A-Za-z0-9]/.test(ascii) ? ascii : "download";
  return `${kind}; filename="${safeAscii}"; filename*=UTF-8''${extValue(filename)}`;
}
