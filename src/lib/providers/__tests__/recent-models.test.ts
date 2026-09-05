import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `recentModelRefs` feeds the picker's "Recent" tab. Two things about it are
 * load-bearing and neither is visible from the returned array alone: the rows
 * must be filtered to `purpose = 'turn'` (background passes may run on a cheaper
 * aux model the user never picked, and a pending budget hold has no purpose at
 * all), and each row must be re-encoded as the CONFIG-SCOPED ref the picker
 * selects by. So the suite asserts on the SQL that was built as well as on the
 * mapping.
 */
const captured = vi.hoisted(() => ({ where: undefined as unknown, rows: [] as Record<string, unknown>[] }));

vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = (w: unknown) => { captured.where = w; return chain; };
  chain.groupBy = () => chain;
  chain.orderBy = () => chain;
  chain.limit = () => Promise.resolve(captured.rows);
  return { db: { select: () => chain } };
});

import { recentModelRefs } from "@/lib/providers/recent-models";

const renderedWhere = () => new PgDialect().sqlToQuery(captured.where as never).sql;

beforeEach(() => {
  captured.where = undefined;
  captured.rows = [];
});

describe("recentModelRefs", () => {
  it("re-encodes each row as the picker's config-scoped ref", async () => {
    captured.rows = [
      { model: "anthropic/claude-opus-4.1", configId: "cfg1" },
      { model: "openai/gpt-5", configId: "cfg2" },
    ];

    expect(await recentModelRefs("u1")).toEqual(["cfg1:anthropic/claude-opus-4.1", "cfg2:openai/gpt-5"]);
  });

  it("keeps the ledger's order rather than re-sorting", async () => {
    captured.rows = [
      { model: "z-model", configId: "cfg1" },
      { model: "a-model", configId: "cfg1" },
    ];

    // Recency is the entire content of this list; alphabetical order would be a
    // different feature wearing its name.
    expect(await recentModelRefs("u1")).toEqual(["cfg1:z-model", "cfg1:a-model"]);
  });

  it("falls back to the bare model id when the spend has no connection", async () => {
    // Rows written before `usage.config_id` existed, and single-credential modes,
    // carry no connection — the picker keys those by the bare id.
    captured.rows = [{ model: "gpt-4o", configId: null }];

    expect(await recentModelRefs("u1")).toEqual(["gpt-4o"]);
  });

  it("filters to settled turns, so aux passes and pending holds cannot appear", async () => {
    await recentModelRefs("u1");

    const sql = renderedWhere();
    expect(sql).toContain('"purpose"');
    expect(sql).toContain('"user_id"');
    // A window, not the whole ledger — a model used once a year ago is not recent.
    expect(sql).toContain('"created_at"');
  });
});
