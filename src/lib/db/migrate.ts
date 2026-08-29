import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { migrateMemoryDocs } from "@/lib/vault/migrate-memory-docs";
import { db, pool } from "./index";

// Fixed advisory-lock id so concurrent instances don't run migrations at the
// same time — the others wait, then see everything already applied.
const MIGRATION_LOCK = 873_2025;

// Backoff between background retries, in seconds; the last value repeats.
const RETRY_SECONDS = [1, 2, 5, 15, 30, 60];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyPending(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    console.log("[db] migrations up to date");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

/**
 * Carry legacy memory docs into the vault, once the schema is known to be there.
 *
 * Not awaited by the caller, and deliberately: unlike the schema, this is a data
 * migration nobody is blocked on — until it lands, memory still reads from the
 * legacy doc — so making boot wait on it would only delay serving. It retries on
 * the same backoff as the migrations above rather than a second scheme of its
 * own, and never rejects, so a failing carry cannot take the boot down with it.
 */
async function carryMemoryDocsIntoVault(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { migrated } = await migrateMemoryDocs();
      if (migrated > 0) console.log(`[db] carried ${migrated} legacy memory doc(s) into the vault`);
      return;
    } catch (e) {
      console.error("[db] memory-doc migration failed (retrying in the background):", e);
    }
    await sleep(RETRY_SECONDS[Math.min(attempt, RETRY_SECONDS.length - 1)] * 1000);
  }
}

/**
 * Apply any pending migrations on boot. Makes self-hosting "just work": a fresh
 * deploy brings the schema up to date without anyone running drizzle-kit.
 * Idempotent and safe to call on every start.
 *
 * Never rejects, and never blocks boot on a database that isn't up yet: the
 * setup page has to load to surface the problem. The first attempt is awaited
 * so a healthy start has its schema ready before the worker takes a task; a
 * failed one keeps retrying in the background.
 *
 * That retry is the whole point. Nothing guarantees the database is up before
 * we are — a dev server started ahead of its Postgres, a compose stack the
 * platform wins the race against — and every other consumer here already
 * tolerates that (the worker retries its poll forever, the pool reconnects).
 * A one-shot attempt that lost the race froze the schema until someone
 * restarted the process, while the app reconnected and looked healthy: queries
 * failed naming a table nobody had created, never the migration that never ran.
 */
export async function runMigrations(): Promise<void> {
  try {
    await applyPending();
    // Called after EVERY successful `applyPending` — here and in the retry loop
    // below — because that is the only place that knows the schema is actually
    // there. `runMigrations` never rejects, so "after it returns" in
    // instrumentation would not mean the migrations ran.
    void carryMemoryDocsIntoVault();
    return;
  } catch (e) {
    console.error("[db] auto-migration failed (continuing; retrying in the background):", e);
  }

  void (async () => {
    for (let attempt = 0; ; attempt++) {
      await sleep(RETRY_SECONDS[Math.min(attempt, RETRY_SECONDS.length - 1)] * 1000);
      try {
        await applyPending();
        void carryMemoryDocsIntoVault();
        return;
      } catch (e) {
        console.error("[db] auto-migration retry failed:", e instanceof Error ? e.message : e);
      }
    }
  })();
}
