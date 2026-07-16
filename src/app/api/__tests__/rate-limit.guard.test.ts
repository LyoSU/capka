import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const guardedRoutes = [
  ["sandbox/files/archive/route.ts", "workspaceArchive"],
  ["sandbox/files/download-all/route.ts", "workspaceArchive"],
  ["ask/answer/route.ts", "askAnswer"],
  ["extensions/install/route.ts", "extensionMutation"],
  ["admin/marketplaces/install/route.ts", "extensionMutation"],
  ["extensions/route.ts", "extensionMutation"],
  ["chats/clone/route.ts", "chatCopy"],
  ["chats/fork/route.ts", "chatCopy"],
] as const;

describe("resource-intensive API rate-limit perimeter", () => {
  it.each(guardedRoutes)("api/%s uses the %s policy", (route, policy) => {
    const source = readFileSync(path.join(process.cwd(), "src", "app", "api", route), "utf8");
    expect(source).toContain("guardRateLimit(");
    expect(source).toContain(`RATE_LIMITS.${policy}`);
  });
});
