import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index";

// Fixed advisory-lock id so concurrent instances don't run migrations at the
// same time — the others wait, then see everything already applied.
const MIGRATION_LOCK = 873_2025;

/**
 * Apply any pending migrations on boot. Makes self-hosting "just work": a fresh
 * deploy brings the schema up to date without anyone running drizzle-kit.
 * Idempotent and safe to call on every start.
 */
export async function runMigrations(): Promise<void> {
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
