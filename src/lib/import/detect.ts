import type { DetectedShareLink, ImportSource } from "./types";

/**
 * The exact host + path shapes we accept, per service. This is an ALLOWLIST, not
 * a heuristic: the server hands the detected URL to a headless browser, so a
 * loose match would be an open redirect / SSRF vector. Each entry pins the
 * host(s) and the `/share/<id>` path, and extracts the opaque id.
 */
const MATCHERS: {
  source: ImportSource;
  hosts: string[];
  /** Path must match; capture group 1 is the share id. */
  path: RegExp;
}[] = [
  {
    source: "claude",
    hosts: ["claude.ai", "www.claude.ai"],
    // /share/<uuid>
    path: /^\/share\/([0-9a-f-]{16,64})\/?$/i,
  },
  {
    source: "chatgpt",
    hosts: ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"],
    // /share/<id> — id is a uuid, optionally prefixed with "e/" for the
    // enterprise/edu share variant.
    path: /^\/share\/(?:e\/)?([0-9a-z-]{16,64})\/?$/i,
  },
  {
    source: "grok",
    hosts: ["grok.com", "www.grok.com"],
    // /share/<id> — id is a base64-ish prefix + underscore + uuid.
    path: /^\/share\/([A-Za-z0-9_-]{16,128})\/?$/,
  },
  {
    source: "gemini",
    hosts: ["gemini.google.com"],
    // Canonical /share/<hex>.
    path: /^\/share\/([0-9a-f]{6,32})\/?$/i,
  },
  {
    source: "gemini",
    hosts: ["share.gemini.google"],
    // Short link: a bare /<id> with no /share prefix; it 3xx-redirects to the
    // canonical gemini.google.com/share/<hex>, which the headless browser follows.
    path: /^\/([A-Za-z0-9_-]{8,64})\/?$/,
  },
];

/**
 * If `text` is exactly one supported share link (leading/trailing whitespace
 * tolerated, nothing else), return which service it's from and a canonical
 * `https://host/share/<id>` URL — otherwise null. Pure and side-effect-free so
 * the composer and the API validate identically.
 *
 * Requiring the *whole* trimmed input to be the URL is deliberate: it makes the
 * "paste a link, get an import offer" gesture predictable and never fires on a
 * link buried mid-sentence.
 */
export function detectShareLink(text: string): DetectedShareLink | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  // Only ever fetch https. (A pasted http link is upgraded, not rejected — the
  // services are https-only anyway, so this just tolerates a sloppy paste.)
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const host = u.hostname.toLowerCase();
  for (const m of MATCHERS) {
    if (!m.hosts.includes(host)) continue;
    const hit = m.path.exec(u.pathname);
    if (!hit) continue;
    // Canonical form: drop query/hash/userinfo/port, force https, lowercase host.
    // The path keeps the matched shape (incl. an "e/" prefix for chatgpt).
    return { source: m.source, url: `https://${host}${u.pathname.replace(/\/$/, "")}` };
  }
  return null;
}

/** Human-facing service name for UI copy and error messages. */
export function sourceLabel(source: ImportSource): string {
  switch (source) {
    case "claude":
      return "Claude";
    case "chatgpt":
      return "ChatGPT";
    case "gemini":
      return "Gemini";
    case "grok":
      return "Grok";
  }
}
