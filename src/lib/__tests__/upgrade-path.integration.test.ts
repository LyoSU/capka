import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { convertToModelMessages, type ModelMessage } from "ai";
import { decrypt } from "../crypto";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run --config vitest.integration.db.config.ts upgrade-path
//
// A database exactly as the LAST RELEASE left it — its own migrations plus a few rows of
// every shape the read paths below care about — upgraded by HEAD's migrator and then read
// the way the app reads it on the first boot after an update. The fixture is generated,
// never hand-edited: see scripts/upgrade-fixture.mjs, and regenerate it after each release.
//
// It needs a database of its own (the shared test database is already at HEAD's schema),
// so it creates one next to DATABASE_URL's and drops it afterwards. Every app module is
// imported only after DATABASE_URL points there, because `@/lib/db` binds its pool at
// import time.
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const FIXTURE = path.join(__dirname, "fixtures/last-release.sql");
// The throwaway key scripts/upgrade-fixture.mjs sealed the fixture's provider key with.
const FIXTURE_MASTER_KEY = "f1f2f3f4f5f6f7f8f9fafbfcfdfeff00f1f2f3f4f5f6f7f8f9fafbfcfdfeff00";

/** Tool calls in a model prompt that no tool result answers — what a provider rejects
 *  (the SDK throws AI_MissingToolResultsError before the request is even sent). */
function unpairedCalls(msgs: ModelMessage[]): string[] {
  const calls: string[] = [];
  const results = new Set<string>();
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === "tool-call") calls.push(p.toolCallId);
      if (p.type === "tool-result") results.add(p.toolCallId);
    }
  }
  return calls.filter((id) => !results.has(id));
}

run("upgrade from the last release", () => {
  const baseUrl = process.env.DATABASE_URL!;
  const dbName = `capka_upgrade_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: baseUrl });
  let app: {
    db: typeof import("../db");
    schema: typeof import("../db/schema");
    tree: typeof import("../chat/tree");
    presenter: typeof import("../chat/presenter");
    build: typeof import("../chat/context/build");
    seal: typeof import("../chat/tool-results");
    queue: typeof import("../tasks/queue");
    turnWrites: typeof import("../vault/turn-writes");
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${dbName}`;
    // Its own connection: the dump empties search_path for the session that loads it.
    const loader = new Client({ connectionString: url.href });
    await loader.connect();
    try {
      await loader.query(readFileSync(FIXTURE, "utf8"));
    } finally {
      await loader.end();
    }
    process.env.DATABASE_URL = url.href;
    app = {
      db: await import("../db"),
      schema: await import("../db/schema"),
      tree: await import("../chat/tree"),
      presenter: await import("../chat/presenter"),
      build: await import("../chat/context/build"),
      seal: await import("../chat/tool-results"),
      queue: await import("../tasks/queue"),
      turnWrites: await import("../vault/turn-writes"),
    };
    // The call `runMigrations` makes at boot (src/lib/db/migrate.ts), minus its
    // never-reject retry loop, which would turn a failed upgrade into a log line here.
    await migrate(app.db.db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  }, 120_000);

  afterAll(async () => {
    await app?.db.pool.end();
    process.env.DATABASE_URL = baseUrl;
    // `end()` resolves before every backend has gone; dropping under one that is still
    // closing kills it mid-goodbye and surfaces as an uncaught error from this file.
    for (let i = 0; i < 50; i++) {
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [dbName]);
      if (rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const chat = async (id: string) =>
    (await app.db.pool.query<{ user_id: string; active_leaf_id: string | null }>(
      `SELECT user_id, active_leaf_id FROM chats WHERE id = $1`, [id])).rows[0];

  /** GET /api/chat for one chat: the active path, its turn writes, the presenter. */
  async function render(chatId: string) {
    const c = await chat(chatId);
    const p = await app.tree.loadActivePath(chatId, c.active_leaf_id);
    const rows = p.map((x) => ({ ...x.node, siblingIndex: x.siblingIndex, siblingCount: x.siblingCount }));
    const writes = await app.turnWrites.readTurnWrites(rows.map((r) => r.id), c.user_id);
    return { rows, ui: app.presenter.toUIMessages(rows, writes) };
  }

  /** The runner's model history for a chat: build, steers, presenter, seal, convert. */
  async function history(chatId: string, clearToolsKeepLast?: number) {
    const c = await chat(chatId);
    const nodes = (await app.tree.loadActivePath(chatId, c.active_leaf_id)).map((x) => x.node);
    const assembled = app.build.buildModelContext(nodes, clearToolsKeepLast === undefined ? {} : { clearToolsKeepLast });
    const ui = app.presenter.toUIMessages(app.presenter.expandSteers(assembled));
    return convertToModelMessages(app.seal.sealOrphanToolCalls(ui) as never);
  }

  const toolPart = (ui: ReturnType<typeof app.presenter.toUIMessages>, callId: string) =>
    ui.flatMap((m) => m.parts as Array<Record<string, unknown>>).find((p) => p.toolCallId === callId);

  it("migrates to HEAD's journal and every HEAD table reads with every HEAD column", async () => {
    const journal = JSON.parse(readFileSync(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"));
    const { rows } = await app.db.pool.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(rows[0].n).toBe(journal.entries.length);
    // A select of every declared column fails on any column schema.ts has and the
    // migrations never created — the drift a fresh-database run cannot see.
    const tables = Object.values(app.schema).filter((t) => is(t, PgTable));
    expect(tables.length).toBeGreaterThan(40);
    for (const t of tables) await app.db.db.select().from(t as PgTable).limit(1);
  });

  it("renders every chat's active path, old shapes included", async () => {
    const { rows: chats } = await app.db.pool.query<{ id: string; active_leaf_id: string }>(
      `SELECT id, active_leaf_id FROM chats ORDER BY id`);
    expect(chats.length).toBeGreaterThanOrEqual(7);
    for (const c of chats) {
      const { rows, ui } = await render(c.id);
      expect(rows.at(-1)?.id, c.id).toBe(c.active_leaf_id);
      expect(ui).toHaveLength(rows.length);
    }

    const c1 = await render("up-c1");
    expect(c1.rows.map((r) => r.id)).toEqual(["c1u1", "c1a1", "c1u2", "c1a2"]);
    expect(c1.rows[1]).toMatchObject({ siblingIndex: 1, siblingCount: 2 }); // a regenerated reply
    expect(toolPart(c1.ui, "call_c1_1")?.state).toBe("output-available");
    expect(toolPart(c1.ui, "call_c1_2")?.state).toBe("output-error"); // invalid call
    expect(toolPart(c1.ui, "call_c1_3")?.state).toBe("output-available"); // legacy toolCalls format

    const c2 = await render("up-c2");
    expect(toolPart(c2.ui, "call_c2_a")).toMatchObject({ state: "approval-responded", approval: { approved: false } });
    expect(toolPart(c2.ui, "call_c2_b")?.state).toBe("output-available");

    // A card still waiting at the leaf stays actionable.
    expect(toolPart((await render("up-c4")).ui, "call_c4_a")?.state).toBe("approval-requested");
  });

  it("builds a model history with every tool call answered, plain and tool-cleared", async () => {
    for (const id of ["up-c1", "up-c2", "up-c5", "up-c6", "up-c7"]) {
      for (const keep of [undefined, 0]) {
        const msgs = await history(id, keep);
        expect(unpairedCalls(msgs), `${id} keep=${keep}`).toEqual([]);
      }
    }
    // The declined approval the chat moved past carries its denial as a result.
    const c2 = await history("up-c2");
    const denial = c2.flatMap((m) => (m.role === "tool" ? m.content : []))
      .find((p) => p.type === "tool-result" && p.toolCallId === "call_c2_a");
    expect(denial).toBeDefined();
  });

  // Inherited from v0.42.0: an approval card left undecided while the chat moved on
  // stayed a bare tool call, and every later turn in that chat died with
  // AI_MissingToolResultsError. Such a row heals at read time, as a decline.
  it("pairs an undecided approval the chat moved past", async () => {
    for (const keep of [undefined, 0]) {
      const msgs = await history("up-c3", keep);
      expect(unpairedCalls(msgs), `keep=${keep}`).toEqual([]);
      const denial = msgs.flatMap((m) => (m.role === "tool" ? m.content : []))
        .find((p) => p.type === "tool-result" && p.toolCallId === "call_c3_a");
      expect(denial).toBeDefined();
    }
  });

  it("reconcileZombies reaps the dead turn, keeps the live one and sweeps exactly the stale holds", async () => {
    const reaped = await app.queue.reconcileZombies();
    expect(reaped.map((r) => r.id)).toEqual(["t-c5-dead"]);

    const { rows: tasks } = await app.db.pool.query(
      `SELECT id, status FROM tasks WHERE id IN ('t-c5-dead', 't-c6-live', 't-c7-q') ORDER BY id`);
    expect(tasks).toEqual([
      { id: "t-c5-dead", status: "failed" },
      { id: "t-c6-live", status: "running" },
      { id: "t-c7-q", status: "queued" },
    ]);

    const { rows: [m] } = await app.db.pool.query(`SELECT content, metadata FROM messages WHERE id = 'c5a1'`);
    expect(m.metadata).toMatchObject({ status: "failed", errorCategory: "interrupted_partial" });
    expect(m.content).toBe("Converting the file…");
    expect(toolPart((await render("up-c5")).ui, "call_c5_a")?.state).toBe("output-error");

    const { rows: usage } = await app.db.pool.query(`SELECT id FROM usage ORDER BY id`);
    expect(usage.map((u) => u.id)).toEqual(["h-c6", "h-c7", "us-c1a1"]);
  });

  it("still decrypts a provider key stored by the release", async () => {
    const { rows: [pc] } = await app.db.pool.query(`SELECT api_key FROM provider_configs WHERE id = 'up-pc'`);
    expect(decrypt(pc.api_key, FIXTURE_MASTER_KEY)).toBe("sk-fixture-not-a-real-key");
  });
});
