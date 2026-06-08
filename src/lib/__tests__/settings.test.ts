import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the DB so getMasterKey's fallback path never touches a real database.
vi.mock("../db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] as unknown[] }) }) }),
    insert: () => ({ values: async () => undefined }),
  },
}));

describe("getMasterKey", () => {
  const ORIGINAL = process.env.UNCLAW_MASTER_KEY;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.UNCLAW_MASTER_KEY;
    else process.env.UNCLAW_MASTER_KEY = ORIGINAL;
  });

  it("returns UNCLAW_MASTER_KEY from env when set, ignoring the DB", async () => {
    process.env.UNCLAW_MASTER_KEY = "deadbeef".repeat(8); // 64 hex chars
    const { getMasterKey } = await import("../settings");
    expect(await getMasterKey()).toBe("deadbeef".repeat(8));
  });

  it("trims surrounding whitespace from the env value", async () => {
    process.env.UNCLAW_MASTER_KEY = "  abc123  ";
    const { getMasterKey } = await import("../settings");
    expect(await getMasterKey()).toBe("abc123");
  });
});
