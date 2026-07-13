import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_IMPORT_SCRIPT } from "../sandbox-script";

// The sandbox script is shipped as a string, so tsc/eslint never see its body.
// These tests are the static safety net: (1) the string must PARSE, and must
// stay free of backticks/template interpolation (it is embedded in a template
// literal — a valid-looking `${ident}` would silently inline platform-side
// values); (2) the bootstrap path (args decode → playwright resolve → emit)
// must produce a sentinel-wrapped payload when run by a real node with no
// playwright available, proving the platform can always extract SOMETHING.
describe("SANDBOX_IMPORT_SCRIPT", () => {
  it("parses as JavaScript and contains no template-literal syntax", () => {
    // Parse-only check of a static constant from our own source (never called,
    // no interpolation) — not an eval of untrusted input.
    expect(() => new Function(SANDBOX_IMPORT_SCRIPT)).not.toThrow();
    expect(SANDBOX_IMPORT_SCRIPT).not.toContain("`");
    expect(SANDBOX_IMPORT_SCRIPT).not.toContain("${");
  });

  it("emits a sentinel-wrapped PLAYWRIGHT_MISSING when playwright can't resolve", () => {
    // Run from a temp dir OUTSIDE the repo so require("playwright") finds
    // neither the project's node_modules nor (NODE_PATH blanked) the global one.
    const dir = mkdtempSync(join(tmpdir(), "capka-import-test-"));
    const file = join(dir, "capka-import.cjs");
    writeFileSync(file, SANDBOX_IMPORT_SCRIPT);
    try {
      const stdout = execFileSync(process.execPath, [file], {
        cwd: dir,
        env: {
          ...process.env,
          NODE_PATH: "",
          CAPKA_IMPORT_ARGS: Buffer.from(
            JSON.stringify({ url: "https://example.com", source: "claude" }),
          ).toString("base64"),
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      const s = stdout.indexOf("<<<CAPKA_IMPORT>>>");
      const e = stdout.indexOf("<<<CAPKA_END>>>");
      expect(s).toBeGreaterThanOrEqual(0);
      expect(e).toBeGreaterThan(s);
      const payload = JSON.parse(stdout.slice(s + "<<<CAPKA_IMPORT>>>".length, e));
      expect(payload).toEqual({ ok: false, code: "PLAYWRIGHT_MISSING" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
