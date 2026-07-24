import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { READABLE_KEYS, WRITABLE_KEYS } from "../keys";

/**
 * The generic settings route answers only for whitelisted keys, so a page calling
 * `useSetting("something_new")` without the key being listed gets a 403 on read AND
 * on write: the control renders its fallback and every save fails. That is exactly
 * how the `memory_enabled` switch shipped broken in 0.13.1 — types, lint, and 1181
 * tests were green, because nothing tied the two sides together.
 *
 * Reads the real call sites out of the source, so a page added later that reads an
 * unlisted key fails here instead of in production.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "node_modules") sources(path, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Comments are stripped first: prose that MENTIONS a call (e.g. a note explaining
 *  why a key was retired) must not read as a call site, or the check misfires and
 *  gets silenced. */
function usedKeys(): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = [];
  for (const file of sources("src")) {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(/useSetting\(\s*["'`]([\w.]+)["'`]/g)) {
      out.push({ key: m[1], file });
    }
  }
  return out;
}

describe("settings route whitelist", () => {
  it("lists every key a page actually reads through useSetting", () => {
    const used = usedKeys();
    // Guard the guard: if the regex ever stops matching, this would pass vacuously.
    expect(used.length).toBeGreaterThan(5);

    const missing = used.filter((u) => !READABLE_KEYS.includes(u.key));
    expect(missing.map((m) => `${m.key} (${m.file})`)).toEqual([]);
  });

  it("keeps every readable key writable, since useSetting both reads and persists", () => {
    // The hook has no read-only mode, so readable-but-not-writable would render
    // correctly and then fail on save — the worse half of the same bug.
    expect(READABLE_KEYS.filter((k) => !WRITABLE_KEYS.includes(k))).toEqual([]);
  });
});
