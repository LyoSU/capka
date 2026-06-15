import { describe, it, expect } from "vitest";
import { dedupeServersByPrecedence } from "../service";
import type { McpServerInfo } from "../types";

const s = (o: Partial<McpServerInfo>): McpServerInfo => ({
  id: o.name ?? "id", scope: "system", name: "x", transport: "http",
  url: "https://e.x/mcp", enabled: true, ...o,
});

describe("dedupeServersByPrecedence", () => {
  it("project beats user beats system", () => {
    const out = dedupeServersByPrecedence([
      s({ id: "sys", scope: "system", name: "dup" }),
      s({ id: "usr", scope: "user", name: "dup" }),
      s({ id: "prj", scope: "project", name: "dup" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("prj");
  });
});
