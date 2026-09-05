import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_SCOPE,
  DASHBOARD_SCOPE,
  DEV_SCOPE,
  SETTINGS_SCOPE,
  SETUP_SCOPE,
  SHARE_SCOPE,
} from "../messages";

/**
 * Each route group provides its own slice of the catalog, so a component can now
 * be rendered under a scope that never heard of its namespace. next-intl prints
 * the key path in that case rather than throwing, which is invisible to every
 * other test and to the build.
 *
 * So: walk the import graph from each group's files, collect every namespace the
 * reachable code asks for, and require the group's scope to cover it. A false
 * positive here (a component imported but never rendered on that route) is worth
 * paying — it costs a few keys in a payload, where a false negative costs a page
 * of `settings.usage.title` in production.
 */

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const SRC = join(ROOT, "src");

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Namespace -> the file that asks for it, so a failure names something to open. */
function namespacesReachableFrom(entries: string[]): Map<string, string> {
  const seen = new Set<string>();
  const found = new Map<string, string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:useTranslations|getTranslations)\(\s*["']([A-Za-z0-9_.]+)["']/g)) {
      if (!found.has(m[1])) found.set(m[1], file.slice(ROOT.length + 1));
    }
    // Static and dynamic imports both: half the heavy panels arrive via `import()`.
    for (const m of source.matchAll(/(?:from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\))/g)) {
      const target = resolveSpec(m[1] ?? m[2], file);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return found;
}

function filesUnder(dir: string, skip?: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (skip && p.includes(skip)) continue;
    if (entry.isDirectory()) out.push(...filesUnder(p, skip));
    else if (/\.tsx?$/.test(entry.name) && !p.includes("__tests__")) out.push(p);
  }
  return out;
}

/**
 * A scope covers a namespace when it names it, an ancestor of it, or a single key
 * inside it.
 *
 * That last case is deliberate and narrow: the signed-out shell asks for
 * `settings.general` to render one footer string, and shipping the other forty for
 * it would undo the point. It is the one place the scope is finer than the
 * `useTranslations` call, so it is also the one place this check cannot tell a
 * missing string from an unused one.
 */
function covers(scope: string[], namespace: string): boolean {
  return scope.some(
    (path) => namespace === path || namespace.startsWith(`${path}.`) || path.startsWith(`${namespace}.`),
  );
}

const ROUTES: Array<{ name: string; dirs: string[]; skip?: string; scope: string[] }> = [
  // Signed-out surfaces sit directly under the root provider.
  { name: "signed out", dirs: ["src/app/(auth)", "src/app/pending", "src/app/suspended"], scope: [] },
  {
    name: "dashboard",
    dirs: ["src/app/(dashboard)"],
    // Settings replaces the scope for its own subtree, so it is walked separately.
    skip: "/settings/",
    scope: DASHBOARD_SCOPE,
  },
  { name: "settings", dirs: ["src/app/(dashboard)/settings"], scope: SETTINGS_SCOPE },
  { name: "setup", dirs: ["src/app/(setup)"], scope: SETUP_SCOPE },
  { name: "share", dirs: ["src/app/share"], scope: SHARE_SCOPE },
  { name: "dev", dirs: ["src/app/dev"], scope: DEV_SCOPE },
];

describe("route scopes cover the namespaces their pages reach", () => {
  for (const route of ROUTES) {
    it(route.name, () => {
      const entries = route.dirs.flatMap((d) => filesUnder(join(ROOT, d), route.skip));
      expect(entries.length).toBeGreaterThan(0);
      const scope = [...BASE_SCOPE, ...route.scope];
      const missing = [...namespacesReachableFrom(entries)]
        .filter(([ns]) => !covers(scope, ns))
        .map(([ns, file]) => `${ns} (${file})`);
      expect(missing).toEqual([]);
    });
  }
});
