import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Every path that admits a paid turn (reserves a budget hold or enqueues a task)
// is declared here with the flood bucket it takes. A new admission path fails this
// until it says which limit it takes and where it releases its hold — the parity
// gaps between web, Telegram and the continuations were each one path that
// forgot one of the two.
const admissionPaths: Record<string, string | null> = {
  "app/api/chat/route.ts": "chat",
  "app/api/chats/[id]/title/route.ts": "title",
  "lib/ask/authed.ts": "chat",
  // Daily cap + overlap guard instead of a flood bucket: nobody is typing.
  "lib/automations/runs.ts": null,
  "lib/manage/authed.ts": "chat",
  "lib/tasks/runner.ts": "chat",
  "lib/telegram/bot.ts": "chat",
};

const src = path.join(process.cwd(), "src");
const admitting = readdirSync(src, { recursive: true, encoding: "utf8" })
  .map((f) => f.split(path.sep).join("/"))
  .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__") && !/\.test\.tsx?$/.test(f))
  .filter((f) => f !== "lib/tasks/queue.ts" && f !== "lib/billing/limits.ts")
  .filter((f) => /reserveBudget\(|enqueueTask\(/.test(readFileSync(path.join(src, f), "utf8")))
  .sort();

describe("paid-turn admission perimeter", () => {
  it("every path that reserves or enqueues is declared", () => {
    expect(admitting).toEqual(Object.keys(admissionPaths).sort());
  });

  it.each(Object.entries(admissionPaths))("%s releases its hold and takes the %s bucket", (file, key) => {
    const source = readFileSync(path.join(src, file), "utf8");
    expect(source).toContain("releaseHold(");
    if (key) expect(source).toContain(`take(\`${key}:`);
  });
});
