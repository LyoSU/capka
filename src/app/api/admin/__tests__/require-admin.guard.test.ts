import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Guards the admin API perimeter: every route handler under
 * `src/app/api/admin/**` MUST call `requireAdmin()` (which rejects a non-admin
 * session) before doing anything. This is the most load-bearing authz invariant
 * in the app — a new admin route that forgets the gate silently exposes an
 * admin-only operation to any signed-in user.
 *
 * Asserted structurally rather than by spot-reading so the invariant can't rot
 * as routes are added: a manual review verified it across every admin route at
 * one point in time; this keeps it true for the next one added.
 */
describe("admin API authorization perimeter", () => {
  const adminDir = path.join(process.cwd(), "src", "app", "api", "admin");
  const routes = readdirSync(adminDir, { recursive: true, encoding: "utf8" }).filter(
    (f) => path.basename(f) === "route.ts",
  );

  it("discovers the admin routes (guards against a broken glob)", () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)("admin/%s gates on requireAdmin()", (rel) => {
    const src = readFileSync(path.join(adminDir, rel), "utf8");
    expect(
      src.includes("requireAdmin"),
      `admin/${rel} is under /api/admin but never calls requireAdmin() — every admin ` +
        `route must gate on it or it leaks an admin-only operation to any signed-in user`,
    ).toBe(true);
  });
});
