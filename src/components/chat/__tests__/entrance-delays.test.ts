import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * An entrance delay must be a custom property, never a Tailwind delay utility.
 *
 * The `.animate-*` classes in globals.css are unlayered, so they out-rank every
 * Tailwind utility — including `[animation-delay:…]`. The `animation` shorthand's
 * implicit `0s` delay therefore wins, and the utility is silently dead: the greeting
 * was meant to stagger its composer and hints and never did, the controls under an
 * answer were meant to wait for the reasoning spoiler to collapse and never did.
 * Verified in a browser: a layered delay utility computes to 0s, a custom-property
 * utility (`[--delay:80ms]`, `[--i:2]`) reaches the shorthand through `var()`.
 */
const CSS = "src/app/globals.css";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !p.includes("__tests__")) out.push(p);
  }
  return out;
}

describe("entrance delays", () => {
  it("no component pairs an animate-* class with an [animation-delay:…] utility", () => {
    const offenders: string[] = [];
    for (const file of walk("src/components")) {
      const src = readFileSync(file, "utf8");
      const re = /className=(?:"|\{`)[^"`]*\[animation-delay:[^"`]*(?:"|`\})/g;
      for (const m of src.matchAll(re)) if (/animate-/.test(m[0])) offenders.push(`${file}: ${m[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("blur-rise takes its delay from a custom property the call site can set", () => {
    const css = readFileSync(CSS, "utf8");
    const rule = css.slice(css.indexOf(".animate-blur-rise {"));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/var\(--delay/);
  });
});
