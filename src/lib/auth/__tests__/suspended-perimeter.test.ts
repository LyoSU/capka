import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

/**
 * "suspended" is a full lifecycle state, not just a status string. These are the
 * three perimeters that must actively account for it beyond the requireActive
 * gate (which fails closed on any non-active status by construction). Asserted
 * structurally so a refactor that drops one of them can't pass silently.
 */
describe("suspended is gated at every access perimeter", () => {
  it("requireSession routes status through the fail-closed normalizer", () => {
    const src = read("src/lib/auth.ts");
    expect(src).toContain("normalizeAccountStatus");
    // inactiveError must speak to a suspended account (not a generic refusal).
    expect(src).toContain('status === "suspended"');
  });

  it("requireSession itself refuses a non-active account, so the safe default needs no opt-in", () => {
    // Scoped to the function body, not the file: the same line inside requireActive would
    // otherwise satisfy a substring match while a bare requireSession still handed a
    // suspended caller a live session. That is the exact shape of the original defect —
    // every gate had the check except the one everything else is built on.
    const src = read("src/lib/auth.ts");
    const body = src.slice(
      src.indexOf("export async function requireSession()"),
      src.indexOf("export async function requireRole("),
    );
    expect(body).not.toBe("");
    expect(body).toMatch(/if \(status !== "active"\) throw inactiveError\(status\)/);
    // ...and before it hands the session back, not after.
    expect(body.indexOf('throw inactiveError(status)')).toBeLessThan(body.indexOf("return { userId:"));
  });

  it("the dashboard layout parks a suspended session on its own screen", () => {
    const src = read("src/app/(dashboard)/layout.tsx");
    expect(src).toContain('status === "suspended"');
    expect(src).toContain('redirect("/suspended")');
  });

  it("the Telegram gate lets only active accounts through", () => {
    const src = read("src/lib/telegram/bot.ts");
    expect(src).toContain('status !== "active"');
  });
});
