import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Every route that hands a browser a file must name it through the shared
// `download-filename` helpers. A hard-coded literal is exactly how these routes
// ended up all shipping `workspace.tar.gz` — the user's Downloads folder filled
// with `workspace.tar.gz (1)`, `(2)`, and no way to tell which project was which.
// A literal also skips the cross-platform sanitizing: a project named `Q4: plan`
// would be unsaveable on Windows.
const downloadRoutes = [
  "sandbox/files/archive/route.ts",
  "sandbox/files/download-all/route.ts",
  "chats/[id]/export/route.ts",
  // Serves ONE workspace file. Its name comes from the sandbox, where the agent can
  // create `Q4:plan.txt` — legal on Linux, unsaveable on Windows — so it needs the
  // same sanitizing as the archives, plus quote-neutralizing for the header.
  "sandbox/files/download/route.ts",
] as const;

// Comments legitimately NAME the old behavior when explaining why it changed, so
// match against code only — otherwise the guard fires on its own documentation.
const read = (route: string) =>
  readFileSync(path.join(process.cwd(), "src", "app", "api", route), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

describe("download filename perimeter", () => {
  it.each(downloadRoutes)("api/%s builds its filename through the shared helper", (route) => {
    const source = read(route);
    expect(source).toContain("@/lib/download-filename");
    expect(source).toContain("contentDisposition(");
  });

  it.each(downloadRoutes)("api/%s hard-codes no filename in the header", (route) => {
    const source = read(route);
    // No `filename="..."` assembled by hand — that is the helper's job.
    expect(source).not.toMatch(/filename="/);
    expect(source).not.toMatch(/workspace\.(zip|tar\.gz)/);
  });
});
