#!/usr/bin/env node
// Regenerate the upgrade-path fixture: a database exactly as a release left it, which
// src/lib/__tests__/upgrade-path.integration.test.ts loads, migrates with HEAD's migrator
// and reads back through the chat, model-history and reconcile paths.
//
//   DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/postgres \
//   PG_DUMP="docker exec unclaw-postgres-1 pg_dump" \
//   node scripts/upgrade-fixture.mjs v0.43.0
//
// DATABASE_URL names any database on a server where USER may CREATE DATABASE; the
// script works in a scratch database of its own and drops it afterwards. PG_DUMP is the
// pg_dump command (default `pg_dump`); it must reach the same server under the same URL,
// which holds for `docker exec` into the dev Postgres because it listens on 127.0.0.1:5432
// on both sides. Use a pg_dump no newer than CI's Postgres (17).
//
// Run it after cutting a release, against the NEW tag, and commit the result: the
// schema comes from that tag's own migrations (`git archive <tag> drizzle`), never from
// HEAD's. The seed rows below are written in that tag's columns; if a release renames or
// drops a column they name, fix the seed here in the same commit.
//
// No real secrets: the one encrypted value (a provider key) is sealed under
// FIXTURE_MASTER_KEY below, a throwaway key that exists only for this fixture.
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Public and throwaway: also hard-coded in the test, which decrypts the row with it.
const FIXTURE_MASTER_KEY = "f1f2f3f4f5f6f7f8f9fafbfcfdfeff00f1f2f3f4f5f6f7f8f9fafbfcfdfeff00";
const OUT = new URL("../src/lib/__tests__/fixtures/last-release.sql", import.meta.url);

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
  console.error("usage: node scripts/upgrade-fixture.mjs vX.Y.Z   (see the header for the env it needs)");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required (a server where the user may CREATE DATABASE)");
  process.exit(1);
}
const sha = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();

// Same format as src/lib/crypto.ts encrypt(): aes-256-gcm, iv:tag:data in hex.
function encrypt(plaintext) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(FIXTURE_MASTER_KEY, "hex"), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

const tool = (id, name, input, extra = {}) => ({ type: "tool-call", id, name, input, ...extra });
const result = (id, name, output) => ({ type: "tool-result", id, name, output });
const text = (t) => ({ type: "text", text: t });

// Each chat is a chain of [id, role, content, metadata] rows, parented in order.
// Timestamps are fixed so the dump is stable; leases far in the future stay live.
const CHATS = [
  // Plain tool use, a steer, an invalid call, a regenerated sibling, the legacy format.
  ["up-c1", "up-user", [
    ["c1u1", "user", "List the files", null],
    ["c1a1", "assistant", "Here they are.", { taskId: "t-c1a1", status: "completed", steers: [{ id: "s1", text: "only csv", at: "2026-09-20T10:00:30.000Z" }],
      parts: [text("Looking."), tool("call_c1_1", "bash", { command: "ls" }), result("call_c1_1", "bash", { stdout: "a.csv" }),
        tool("call_c1_2", "nope", "{bad"), { type: "tool-error", id: "call_c1_2", name: "nope", error: "Invalid input", invalid: true }, text("Here they are.")] }],
    ["c1u2", "user", "Thanks, and the old way?", null],
    ["c1a2", "assistant", "Done the old way.", { taskId: "t-c1a2", status: "completed",
      toolCalls: [{ id: "call_c1_3", name: "bash", input: { command: "pwd" } }], toolResults: [{ id: "call_c1_3", output: "/workspace" }] }],
  ], [["c1a1b", "c1u1", "assistant", "An older answer.", { status: "completed", parts: [text("An older answer.")] }, "2026-09-20 10:00:10"]]],
  // A DECLINED approval the chat moved past, then an approved one that ran.
  ["up-c2", "up-user", [
    ["c2u1", "user", "Delete the report", null],
    ["c2a1", "assistant", "", { taskId: "t-c2a1", status: "completed",
      parts: [tool("call_c2_a", "delete_file", { path: "report.pdf" }, { approval: { id: "apr-c2-a", approved: false, reason: "keep it" } })] }],
    ["c2u2", "user", "Then archive it", null],
    ["c2a2", "assistant", "Archived.", { taskId: "t-c2a2", status: "completed",
      parts: [tool("call_c2_b", "archive_file", { path: "report.pdf" }, { approval: { id: "apr-c2-b", approved: true } }), result("call_c2_b", "archive_file", { ok: true }), text("Archived.")] }],
    ["c2u3", "user", "Good", null],
    ["c2a3", "assistant", "Anything else?", { taskId: "t-c2a3", status: "completed", parts: [text("Anything else?")] }],
  ]],
  // An UNDECIDED approval the chat moved past (a known open bug at HEAD).
  ["up-c3", "up-user", [
    ["c3u1", "user", "Send the email", null],
    ["c3a1", "assistant", "", { taskId: "t-c3a1", status: "awaiting_approval",
      parts: [tool("call_c3_a", "send_email", { to: "team@example.com" }, { approval: { id: "apr-c3-a" } })] }],
    ["c3u2", "user", "Never mind, summarize instead", null],
    ["c3a2", "assistant", "Summary.", { taskId: "t-c3a2", status: "completed", parts: [text("Summary.")] }],
  ]],
  // An undecided approval at the leaf: still waiting, still actionable.
  ["up-c4", "up-user", [
    ["c4u1", "user", "Push the change", null],
    ["c4a1", "assistant", "", { taskId: "t-c4a1", status: "awaiting_approval",
      parts: [text("Pushing needs your OK."), tool("call_c4_a", "git_push", { branch: "main" }, { approval: { id: "apr-c4-a" } })] }],
  ]],
  // A running turn whose worker died: lease long expired, a call left dangling.
  ["up-c5", "up-user", [
    ["c5u1", "user", "Convert the file", null],
    ["c5a1", "assistant", "", { taskId: "t-c5-dead", status: "running",
      parts: [text("Converting the file…"), tool("call_c5_a", "bash", { command: "soffice --convert-to pdf a.docx" })] }],
  ]],
  // A running turn that is still alive.
  ["up-c6", "up-admin", [
    ["c6u1", "user", "Think hard", null],
    ["c6a1", "assistant", "", { taskId: "t-c6-live", status: "running", parts: [text("Thinking")] }],
  ]],
  // A queued turn: the user row exists, the reply does not yet.
  ["up-c7", "up-user", [["c7u1", "user", "Queued question", null]]],
];

const TASKS = [
  // [id, chat, user, status, leaseExpiresAt, payload]
  ["t-c1a1", "up-c1", "up-user", "completed", null, null],
  ["t-c1a2", "up-c1", "up-user", "completed", null, null],
  ["t-c2a1", "up-c2", "up-user", "completed", null, null],
  ["t-c2a2", "up-c2", "up-user", "completed", null, null],
  ["t-c2a3", "up-c2", "up-user", "completed", null, null],
  ["t-c3a1", "up-c3", "up-user", "completed", null, null],
  ["t-c3a2", "up-c3", "up-user", "completed", null, null],
  ["t-c4a1", "up-c4", "up-user", "completed", null, null],
  ["t-c5-dead", "up-c5", "up-user", "running", "2026-09-20 10:05:00", { chatId: "up-c5", assistantMessageId: "c5a1" }],
  ["t-c6-live", "up-c6", "up-admin", "running", "2100-01-01 00:00:00", { chatId: "up-c6", assistantMessageId: "c6a1" }],
  ["t-c7-q", "up-c7", "up-user", "queued", null, { chatId: "up-c7", userMessageId: "c7u1" }],
];

const USAGE = [
  // [id, task, user, pending, cost]
  ["us-c1a1", "t-c1a1", "up-user", false, "0.00120000"], // settled spend: kept
  ["h-c5", "t-c5-dead", "up-user", true, "0.05000000"], // reaped task: released
  ["h-c6", "t-c6-live", "up-admin", true, "0.05000000"], // live task: kept
  ["h-c7", "t-c7-q", "up-user", true, "0.05000000"], // queued task: kept
  ["h-leak", "t-c1a2", "up-user", true, "0.05000000"], // leaked on a completed task: released
  ["h-orphan", "t-gone", "up-user", true, "0.05000000"], // no task row, old: released
];

async function seed(client) {
  await client.query(`INSERT INTO "user" (id, name, email, role, created_at, updated_at) VALUES
    ('up-admin', 'Admin', 'admin@fixture.invalid', 'admin', '2026-09-20 09:00:00', '2026-09-20 09:00:00'),
    ('up-user', 'User', 'user@fixture.invalid', 'user', '2026-09-20 09:00:00', '2026-09-20 09:00:00')`);
  await client.query(
    `INSERT INTO provider_configs (id, user_id, provider, api_key, created_at, updated_at)
     VALUES ('up-pc', 'up-admin', 'openrouter', $1, '2026-09-20 09:00:00', '2026-09-20 09:00:00')`,
    [encrypt("sk-fixture-not-a-real-key")],
  );
  let minute = 0;
  const at = () => `2026-09-20 10:${String(minute++).padStart(2, "0")}:00`;
  for (const [chatId, userId, rows, extra = []] of CHATS) {
    await client.query(`INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
      [chatId, userId, `Fixture ${chatId}`, at()]);
    let parent = null;
    for (const [id, role, content, metadata] of rows) {
      await client.query(
        `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, chatId, parent, role, content, metadata && JSON.stringify(metadata), at()]);
      parent = id;
    }
    for (const [id, parentId, role, content, metadata, createdAt] of extra) {
      await client.query(
        `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, chatId, parentId, role, content, JSON.stringify(metadata), createdAt]);
    }
    await client.query(`UPDATE chats SET active_leaf_id = $2 WHERE id = $1`, [chatId, parent]);
  }
  for (const [id, chatId, userId, status, lease, payload] of TASKS) {
    await client.query(
      `INSERT INTO tasks (id, chat_id, user_id, status, lease_expires_at, worker_id, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-09-20 10:00:00', '2026-09-20 10:00:00')`,
      [id, chatId, userId, status, lease, status === "running" ? "w-fixture" : null, payload && JSON.stringify(payload)]);
  }
  for (const [id, taskId, userId, pending, cost] of USAGE) {
    await client.query(
      `INSERT INTO usage (id, task_id, user_id, provider, model, cost_usd, on_shared_key, purpose, pending, created_at)
       VALUES ($1, $2, $3, 'openrouter', 'fixture/model', $4, true, 'turn', $5, '2026-09-20 10:00:00')`,
      [id, taskId, userId, cost, pending]);
  }
}

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const dbName = `capka_fixture_${process.pid}`;
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${dbName}`;
const work = mkdtempSync(path.join(tmpdir(), "capka-fixture-"));
await admin.query(`CREATE DATABASE ${dbName}`);
try {
  // The release's migrations, not HEAD's: the fixture must be what that release wrote.
  execFileSync("git", ["archive", "--format=tar", "-o", path.join(work, "drizzle.tar"), tag, "drizzle"]);
  execFileSync("tar", ["-xf", path.join(work, "drizzle.tar"), "-C", work]);
  const pool = new pg.Pool({ connectionString: url.href, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(work, "drizzle") });
    const client = await pool.connect();
    try { await seed(client); } finally { client.release(); }
  } finally {
    await pool.end();
  }

  const [cmd, ...pre] = (process.env.PG_DUMP || "pg_dump").split(/\s+/);
  const dump = execFileSync(cmd, [...pre, "--no-owner", "--no-privileges", "--no-comments", "--inserts", `--dbname=${url.href}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // Drop psql-only meta-commands (`\restrict`, pg_dump >= 17.6) — the test loads this
  // over the wire protocol, not through psql — and comments and blank runs, for size.
  const body = dump.split("\n")
    .filter((l) => !l.startsWith("\\") && !l.startsWith("--"))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  mkdirSync(new URL(".", OUT), { recursive: true });
  writeFileSync(OUT, `-- Generated by scripts/upgrade-fixture.mjs from ${tag} (${sha}). Do not edit by hand.
-- The provider key below is encrypted under the throwaway FIXTURE_MASTER_KEY in that script.
${body}
`);
  console.log(`wrote ${path.relative(process.cwd(), OUT.pathname)} from ${tag}`);
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
}
