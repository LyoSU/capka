import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * These endpoints expose durable user data or a live event stream. Authentication
 * alone is intentionally insufficient: a pending/deactivated account must fail
 * before ownership checks, controller calls, database reads, or subscriptions.
 */
describe("sensitive read API authorization perimeter", () => {
  const routes = [
    "chats/[id]/export/route.ts",
    "sandbox/files/download-all/route.ts",
    "memory-docs/route.ts",
    "events/route.ts",
  ];

  it.each(routes)("api/%s gates on requireActive()", (route) => {
    const source = readFileSync(path.join(process.cwd(), "src", "app", "api", route), "utf8");
    expect(source).toContain("requireActive");
    expect(source).not.toContain("requireSession");
  });
});
