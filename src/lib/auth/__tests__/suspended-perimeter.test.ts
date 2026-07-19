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
