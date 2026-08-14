import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const guardedRoutes = [
  ["sandbox/files/archive/route.ts", "workspaceArchive"],
  ["sandbox/files/download-all/route.ts", "workspaceArchive"],
  ["ask/answer/route.ts", "askAnswer"],
  // The three routes that used to do this work now refuse with 410; the work moved behind the
  // install review, which is what has to be limited — and BOTH halves of it, because GET is the
  // expensive one (commit + whole tree + every file + DNS per connector + OAuth probes).
  ["extensions/review/route.ts", "extensionMutation"],
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
